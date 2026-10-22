import type { Clock } from '../chips/pit';
import { SECTOR_BYTES, type HardDiskImage } from './image';

export const CD_SECTOR_BYTES = 2048;

/** A CD-ROM image: 2048-byte sectors (an .iso). */
export class CdImage {
  constructor(
    readonly bytes: Uint8Array,
    readonly name: string,
  ) {}

  get sectorCount(): number {
    return Math.floor(this.bytes.length / CD_SECTOR_BYTES);
  }
}

const BSY = 0x80;
const DRDY = 0x40;
const DSC = 0x10;
const DRQ = 0x08;
const ERR = 0x01;
const ABORT = 0x04;
const ID_NOT_FOUND = 0x10;
const SELECT_LBA = 0x40;
const NIEN = 0x02;
const SRST = 0x04;
const MAX_MULTIPLE = 16;
/** Commands finish this long after they are given, so the driver is waiting when the interrupt comes. */
const COMMAND_NS = 20_000;
/** The activity light stays on this long after the drive was used. */
const ACTIVITY_NS = 150_000_000;

// SCSI sense keys and the additional sense codes used.
const NOT_READY = 2;
const ILLEGAL_REQUEST = 5;
const UNIT_ATTENTION = 6;
const ASC_INVALID_COMMAND = 0x20;
const ASC_LBA_OUT_OF_RANGE = 0x21;
const ASC_INVALID_FIELD = 0x24;
const ASC_MEDIUM_CHANGED = 0x28;
const ASC_NO_MEDIUM = 0x3a;

const enum Transfer {
  None,
  Read,
  Write,
  Packet,
  PacketData,
}

/** Puts an ATA string (two characters per word, the first in the high byte) into words. */
function putString(words: Uint16Array, first: number, length: number, text: string): void {
  const padded = text.padEnd(length * 2, ' ');
  for (let i = 0; i < length; i++) words[first + i] = (padded.charCodeAt(i * 2) << 8) | padded.charCodeAt(i * 2 + 1);
}

/** A hard disk or CD-ROM drive on an IDE channel. */
export class IdeDrive {
  status = DRDY | DSC;
  error = 1;
  /** The drive's interrupt request, cleared by reading its status. */
  interrupt = false;
  multiple = 0;
  logicalHeads = 16;
  logicalSectors = 63;
  /** The time the activity light goes out. */
  activeUntil = 0;
  private transfer = Transfer.None;
  private readonly buffer = new Uint8Array(0x20000);
  private bufferPos = 0;
  private bufferEnd = 0;
  // An ATA transfer: sectors left, the next one's address, the block size.
  private remaining = 0;
  private lba = 0;
  private blockSectors = 1;
  // ATAPI.
  private sense = [0, 0, 0];
  private mediaChanged = false;
  /** The guest has locked the tray (PREVENT MEDIUM REMOVAL). */
  locked = false;
  /** Bytes of a CD read still to come, and the next sector. */
  private cdRemaining = 0;
  private cdLba = 0;

  constructor(
    private readonly channel: IdeChannel,
    readonly disk: HardDiskImage | null,
    public cd: CdImage | null,
    readonly isCdrom: boolean,
  ) {
    if (disk) {
      this.logicalHeads = disk.geometry.heads;
      this.logicalSectors = disk.geometry.sectors;
    }
    this.setSignature();
  }

  get active(): boolean {
    return this.channel.clock.now() < this.activeUntil;
  }

  /** The registers a drive leaves after reset, saying what kind it is. */
  private setSignature(): void {
    const ch = this.channel;
    ch.count = ch.sector = 1;
    if (this.isCdrom) {
      ch.cylLow = 0x14;
      ch.cylHigh = 0xeb;
    } else {
      ch.cylLow = ch.cylHigh = 0;
    }
    ch.select &= 0xf0;
  }

  reset(): void {
    this.transfer = Transfer.None;
    this.status = DRDY | DSC;
    this.error = 1;
    this.interrupt = false;
    this.multiple = 0;
    if (this.disk) {
      this.logicalHeads = this.disk.geometry.heads;
      this.logicalSectors = this.disk.geometry.sectors;
    }
    if (this.isCdrom) this.status = 0;
    this.setSignature();
  }

  /** A new disc (or none). */
  changeMedia(cd: CdImage | null): void {
    this.cd = cd;
    this.mediaChanged = cd !== null;
    this.locked = false;
  }

  private raiseInterrupt(): void {
    this.interrupt = true;
    this.channel.updateIrq();
  }

  private finish(error = 0): void {
    this.transfer = Transfer.None;
    this.error = error;
    this.status = DRDY | DSC | (error ? ERR : 0);
    this.raiseInterrupt();
  }

  private later(step: () => void): void {
    this.status = (this.status | BSY) & ~DRQ;
    this.activeUntil = this.channel.clock.now() + ACTIVITY_NS;
    this.channel.schedule(step, COMMAND_NS);
  }

  // --- Addresses -----------------------------------------------------------------------

  private currentLba(): number {
    const ch = this.channel;
    if (ch.select & SELECT_LBA) return ((ch.select & 0x0f) << 24) | (ch.cylHigh << 16) | (ch.cylLow << 8) | ch.sector;
    const cylinder = (ch.cylHigh << 8) | ch.cylLow;
    return (cylinder * this.logicalHeads + (ch.select & 0x0f)) * this.logicalSectors + ch.sector - 1;
  }

  private setAddress(lba: number): void {
    const ch = this.channel;
    if (ch.select & SELECT_LBA) {
      ch.sector = lba & 0xff;
      ch.cylLow = (lba >> 8) & 0xff;
      ch.cylHigh = (lba >> 16) & 0xff;
      ch.select = (ch.select & 0xf0) | ((lba >> 24) & 0x0f);
      return;
    }
    const perCylinder = this.logicalHeads * this.logicalSectors;
    const cylinder = Math.floor(lba / perCylinder);
    const rest = lba % perCylinder;
    ch.cylLow = cylinder & 0xff;
    ch.cylHigh = (cylinder >> 8) & 0xff;
    ch.select = (ch.select & 0xf0) | Math.floor(rest / this.logicalSectors);
    ch.sector = (rest % this.logicalSectors) + 1;
  }

  // --- Commands --------------------------------------------------------------------------

  command(code: number): void {
    if (this.status & BSY) return;
    this.error = 0;
    this.interrupt = false;
    this.channel.updateIrq();
    if (this.isCdrom) {
      this.cdromCommand(code);
      return;
    }
    const ch = this.channel;
    const sectors = ch.count || 256;
    const disk = this.disk!;
    switch (code) {
      case 0xec:
        this.later(() => this.sendIdentify(this.identifyDisk()));
        return;
      case 0x20:
      case 0x21:
        this.startTransfer(Transfer.Read, sectors, 1);
        return;
      case 0xc4:
        if (!this.multiple) break;
        this.startTransfer(Transfer.Read, sectors, this.multiple);
        return;
      case 0x30:
      case 0x31:
        this.startTransfer(Transfer.Write, sectors, 1);
        return;
      case 0xc5:
        if (!this.multiple) break;
        this.startTransfer(Transfer.Write, sectors, this.multiple);
        return;
      case 0xc6:
        if (ch.count <= MAX_MULTIPLE && !(ch.count & (ch.count - 1))) {
          this.multiple = ch.count;
          this.later(() => this.finish());
          return;
        }
        break;
      case 0x91:
        this.logicalHeads = (ch.select & 0x0f) + 1;
        this.logicalSectors = ch.count || disk.geometry.sectors;
        this.later(() => this.finish());
        return;
      case 0x40:
      case 0x41: {
        const end = this.currentLba() + sectors;
        this.later(() => this.finish(end > disk.sectorCount ? ID_NOT_FOUND : 0));
        return;
      }
      case 0xf8: {
        // READ NATIVE MAX ADDRESS.
        this.later(() => {
          this.setAddress(disk.sectorCount - 1);
          this.finish();
        });
        return;
      }
      case 0x90:
        this.later(() => {
          this.setSignature();
          this.finish();
          this.error = 1;
        });
        return;
      case 0xe5:
      case 0x98:
        this.later(() => {
          ch.count = 0xff;
          this.finish();
        });
        return;
      default:
        if ((code & 0xf0) === 0x10 || (code & 0xf0) === 0x70 || [0xef, 0xe7, 0xe0, 0xe1, 0xe2, 0xe3, 0xe6, 0x94, 0x95, 0x96, 0x97, 0x99, 0xea].includes(code)) {
          this.later(() => this.finish());
          return;
        }
    }
    this.later(() => this.finish(ABORT));
  }

  private identifyDisk(): Uint16Array {
    const disk = this.disk!;
    const { geometry } = disk;
    const total = Math.min(disk.sectorCount, 0x0fffffff);
    const current = Math.min(this.logicalHeads * this.logicalSectors * geometry.cylinders, total);
    const w = new Uint16Array(256);
    w[0] = 0x0040;
    w[1] = geometry.cylinders;
    w[3] = geometry.heads;
    w[4] = SECTOR_BYTES * geometry.sectors;
    w[5] = SECTOR_BYTES;
    w[6] = geometry.sectors;
    putString(w, 10, 10, 'PENTIUMPC0000001');
    w[20] = 3;
    w[21] = 512;
    w[22] = 4;
    putString(w, 23, 4, '1.0');
    putString(w, 27, 20, 'PENTIUMPC HARD DISK');
    w[47] = 0x8000 | MAX_MULTIPLE;
    w[48] = 1;
    w[49] = 0x0200;
    w[51] = 0x0200;
    w[53] = 0x0003;
    w[54] = geometry.cylinders;
    w[55] = this.logicalHeads;
    w[56] = this.logicalSectors;
    w[57] = current & 0xffff;
    w[58] = current >>> 16;
    w[59] = this.multiple ? 0x100 | this.multiple : 0;
    w[60] = total & 0xffff;
    w[61] = total >>> 16;
    w[64] = 0x0003;
    w[65] = w[66] = w[67] = w[68] = 120;
    w[80] = 0x001e;
    w[82] = 0x4000;
    w[83] = 0x4000;
    w[84] = 0x4000;
    return w;
  }

  private identifyCdrom(): Uint16Array {
    const w = new Uint16Array(256);
    w[0] = 0x85c0;
    putString(w, 10, 10, 'PENTIUMPCCD00001');
    putString(w, 23, 4, '1.0');
    putString(w, 27, 20, 'PENTIUMPC CD-ROM');
    w[49] = 0x0200;
    w[53] = 0x0003;
    w[64] = 0x0003;
    w[65] = w[66] = w[67] = w[68] = 120;
    w[71] = w[72] = 30;
    w[80] = 0x001e;
    return w;
  }

  private sendIdentify(words: Uint16Array): void {
    for (let i = 0; i < 256; i++) {
      this.buffer[i * 2] = words[i] & 0xff;
      this.buffer[i * 2 + 1] = words[i] >> 8;
    }
    this.bufferPos = 0;
    this.bufferEnd = SECTOR_BYTES;
    this.transfer = Transfer.Read;
    this.remaining = 0;
    this.status = DRDY | DSC | DRQ;
    this.raiseInterrupt();
  }

  private startTransfer(kind: Transfer, sectors: number, blockSectors: number): void {
    this.lba = this.currentLba();
    if (this.lba + sectors > this.disk!.sectorCount) {
      this.later(() => this.finish(ID_NOT_FOUND));
      return;
    }
    this.transfer = kind;
    this.remaining = sectors;
    this.blockSectors = blockSectors;
    this.activeUntil = this.channel.clock.now() + ACTIVITY_NS;
    if (kind === Transfer.Read) {
      this.later(() => this.nextReadBlock());
    } else {
      this.prepareBlock();
      this.status = DRDY | DSC | DRQ;
    }
  }

  private prepareBlock(): void {
    this.bufferEnd = Math.min(this.blockSectors, this.remaining) * SECTOR_BYTES;
    this.bufferPos = 0;
  }

  private nextReadBlock(): void {
    this.prepareBlock();
    for (let i = 0; i < this.bufferEnd / SECTOR_BYTES; i++) this.disk!.read(this.lba + i, this.buffer, i * SECTOR_BYTES);
    this.status = DRDY | DSC | DRQ;
    this.raiseInterrupt();
  }

  // --- Data port -------------------------------------------------------------------------

  readData16(): number {
    if (!(this.status & DRQ) || (this.transfer !== Transfer.Read && this.transfer !== Transfer.PacketData)) return 0xffff;
    const word = this.buffer[this.bufferPos] | (this.buffer[this.bufferPos + 1] << 8);
    this.bufferPos += 2;
    if (this.bufferPos >= this.bufferEnd) this.blockRead();
    return word;
  }

  writeData16(value: number): void {
    if (!(this.status & DRQ) || (this.transfer !== Transfer.Write && this.transfer !== Transfer.Packet)) return;
    this.buffer[this.bufferPos] = value & 0xff;
    this.buffer[this.bufferPos + 1] = (value >> 8) & 0xff;
    this.bufferPos += 2;
    if (this.bufferPos >= this.bufferEnd) this.blockWritten();
  }

  private blockRead(): void {
    if (this.transfer === Transfer.PacketData) {
      this.nextPacketChunk();
      return;
    }
    if (this.remaining === 0) {
      this.transfer = Transfer.None;
      this.status = DRDY | DSC;
      return;
    }
    const done = this.bufferEnd / SECTOR_BYTES;
    this.lba += done;
    this.remaining -= done;
    this.setAddress(this.lba);
    if (this.remaining > 0) {
      this.later(() => this.nextReadBlock());
    } else {
      this.transfer = Transfer.None;
      this.status = DRDY | DSC;
    }
  }

  private blockWritten(): void {
    if (this.transfer === Transfer.Packet) {
      this.status = BSY | DRDY;
      this.transfer = Transfer.None;
      const packet = this.buffer.slice(0, 12);
      this.channel.schedule(() => this.packet(packet), COMMAND_NS);
      return;
    }
    const done = this.bufferEnd / SECTOR_BYTES;
    for (let i = 0; i < done; i++) this.disk!.write(this.lba + i, this.buffer, i * SECTOR_BYTES);
    this.lba += done;
    this.remaining -= done;
    this.setAddress(this.lba);
    if (this.remaining > 0) {
      this.later(() => {
        this.prepareBlock();
        this.status = DRDY | DSC | DRQ;
        this.raiseInterrupt();
      });
    } else {
      this.later(() => this.finish());
    }
  }

  // --- ATAPI -----------------------------------------------------------------------------

  private cdromCommand(code: number): void {
    const ch = this.channel;
    switch (code) {
      case 0xa1:
        this.later(() => this.sendIdentify(this.identifyCdrom()));
        return;
      case 0xa0:
        // PACKET: the 12-byte command comes through the data port.
        this.transfer = Transfer.Packet;
        this.bufferPos = 0;
        this.bufferEnd = 12;
        ch.count = 0x01;
        this.status = DRDY | DRQ;
        return;
      case 0x08:
        this.reset();
        this.status = 0;
        return;
      case 0xec:
        // IDENTIFY DEVICE is aborted, with the ATAPI signature so the driver knows.
        this.setSignature();
        this.later(() => this.finish(ABORT));
        return;
      case 0x90:
        this.later(() => {
          this.setSignature();
          this.finish();
          this.status = 0;
          this.error = 1;
        });
        return;
      case 0xef:
      case 0xe0:
      case 0xe1:
      case 0xe7:
        this.later(() => this.finish());
        return;
      default:
        this.later(() => this.finish(ABORT));
    }
  }

  /** The byte count limit the driver gave for each transfer. */
  private get byteLimit(): number {
    let limit = this.channel.cylLow | (this.channel.cylHigh << 8);
    if (limit === 0 || limit === 0xffff) limit = 0xfffe;
    return limit & ~1;
  }

  private packetFail(key: number, asc: number): void {
    this.sense = [key, asc, 0];
    this.channel.count = 0x03;
    this.transfer = Transfer.None;
    this.error = key << 4;
    this.status = DRDY | ERR;
    this.raiseInterrupt();
  }

  private packetDone(): void {
    this.sense = [0, 0, 0];
    this.channel.count = 0x03;
    this.transfer = Transfer.None;
    this.status = DRDY | DSC;
    this.raiseInterrupt();
  }

  /** Sends a reply (cut to the length the command allowed). */
  private packetReply(data: Uint8Array | number[], allowed: number): void {
    const length = Math.min(data.length, allowed);
    if (length === 0) {
      this.packetDone();
      return;
    }
    this.buffer.set(data.slice(0, length));
    this.cdRemaining = 0;
    this.startChunk(length);
  }

  private startChunk(length: number): void {
    const ch = this.channel;
    this.bufferPos = 0;
    this.bufferEnd = length;
    ch.cylLow = length & 0xff;
    ch.cylHigh = length >> 8;
    ch.count = 0x02;
    this.transfer = Transfer.PacketData;
    this.status = DRDY | DSC | DRQ;
    this.raiseInterrupt();
  }

  private nextPacketChunk(): void {
    if (this.cdRemaining <= 0) {
      this.packetDone();
      return;
    }
    this.status = BSY;
    this.channel.schedule(() => this.loadCdChunk(), COMMAND_NS);
  }

  /** Reads the next piece of a CD read into the buffer and offers it. */
  private loadCdChunk(): void {
    const limit = this.byteLimit;
    const perChunk = Math.max(1, Math.floor(Math.min(limit, this.buffer.length) / CD_SECTOR_BYTES));
    const sectors = Math.min(perChunk, this.cdRemaining / CD_SECTOR_BYTES);
    const cd = this.cd!;
    this.buffer.set(cd.bytes.subarray(this.cdLba * CD_SECTOR_BYTES, (this.cdLba + sectors) * CD_SECTOR_BYTES));
    this.cdLba += sectors;
    this.cdRemaining -= sectors * CD_SECTOR_BYTES;
    this.activeUntil = this.channel.clock.now() + ACTIVITY_NS;
    this.startChunk(sectors * CD_SECTOR_BYTES);
  }

  private packet(p: Uint8Array): void {
    const op = p[0];
    const u16 = (at: number) => (p[at] << 8) | p[at + 1];
    const u32 = (at: number) => ((p[at] << 24) | (p[at + 1] << 16) | (p[at + 2] << 8) | p[at + 3]) >>> 0;
    // Commands that work without a disc, and that don't report a disc change.
    if (op === 0x03) {
      // 16 bytes rather than the usual 18 (the additional length says so): SeaBIOS reads replies
      // a dword at a time, and would leave two bytes of an 18-byte reply behind.
      const [key, asc, ascq] = this.sense;
      const data = new Uint8Array(16);
      data[0] = 0x70;
      data[2] = key;
      data[7] = 8;
      data[12] = asc;
      data[13] = ascq;
      this.sense = [0, 0, 0];
      this.packetReply(data, p[4]);
      return;
    }
    if (op === 0x12) {
      const data = new Uint8Array(36);
      data[0] = 0x05;
      data[1] = 0x80;
      data[2] = 0x00;
      data[3] = 0x21;
      data[4] = 31;
      const text = 'BROWSER PENTIUMPC CD-ROM1.0 ';
      for (let i = 0; i < 28; i++) data[8 + i] = text.charCodeAt(i);
      this.packetReply(data, p[4]);
      return;
    }
    if (op === 0x4a) {
      // GET EVENT STATUS NOTIFICATION: media events.
      const event = this.mediaChanged ? 2 : 0;
      const data = [0, 6, 4, 0x10, event, this.cd ? 2 : 0, 0, 0];
      this.packetReply(data, u16(7));
      return;
    }
    if (op === 0xbd) {
      const data = new Uint8Array(8);
      data[5] = 1;
      this.packetReply(data, u16(8));
      return;
    }
    if (op === 0x46) {
      const data = new Uint8Array(8);
      data[3] = 8;
      data[6] = 0;
      data[7] = this.cd ? 0x08 : 0;
      this.packetReply(data, u16(7));
      return;
    }
    if (op === 0x1e) {
      this.locked = (p[4] & 1) !== 0;
      this.packetDone();
      return;
    }
    if (!this.cd) {
      this.packetFail(NOT_READY, ASC_NO_MEDIUM);
      return;
    }
    if (this.mediaChanged) {
      this.mediaChanged = false;
      this.packetFail(UNIT_ATTENTION, ASC_MEDIUM_CHANGED);
      return;
    }
    const cd = this.cd;
    switch (op) {
      case 0x00:
      case 0x1b:
      case 0x2b:
      case 0xbb:
      case 0x47:
      case 0x4b:
      case 0x4e:
        this.packetDone();
        return;
      case 0x25: {
        const last = cd.sectorCount - 1;
        this.packetReply([last >>> 24, (last >> 16) & 0xff, (last >> 8) & 0xff, last & 0xff, 0, 0, 8, 0], 8);
        return;
      }
      case 0x28:
      case 0xa8: {
        const lba = u32(2);
        const count = op === 0x28 ? u16(7) : u32(6);
        if (count === 0) {
          this.packetDone();
          return;
        }
        if (lba + count > cd.sectorCount) {
          this.packetFail(ILLEGAL_REQUEST, ASC_LBA_OUT_OF_RANGE);
          return;
        }
        this.cdLba = lba;
        this.cdRemaining = count * CD_SECTOR_BYTES;
        this.loadCdChunk();
        return;
      }
      case 0x43:
        this.readToc(p[1] & 2 ? 'msf' : 'lba', p[9] >> 6 || p[2] & 0xf, p[6], u16(7));
        return;
      case 0x42: {
        // READ SUB-CHANNEL: no audio is playing.
        const data = new Uint8Array(p[2] & 0x40 ? 16 : 4);
        data[1] = 0x15;
        if (data.length > 4) {
          data[3] = 12;
          data[4] = 1;
        }
        this.packetReply(data, u16(7));
        return;
      }
      case 0x51: {
        const data = new Uint8Array(34);
        data[1] = 32;
        data[2] = 0x0e;
        data[3] = data[4] = data[5] = data[6] = 1;
        this.packetReply(data, u16(7));
        return;
      }
      case 0x1a:
      case 0x5a:
        this.modeSense(op === 0x5a, p[2] & 0x3f, op === 0x5a ? u16(7) : p[4]);
        return;
      default:
        this.packetFail(ILLEGAL_REQUEST, ASC_INVALID_COMMAND);
    }
  }

  private static msf(lba: number): [number, number, number] {
    const frames = lba + 150;
    return [Math.floor(frames / 4500), Math.floor(frames / 75) % 60, frames % 75];
  }

  private readToc(mode: 'msf' | 'lba', format: number, track: number, allowed: number): void {
    const cd = this.cd!;
    const address = (lba: number) => {
      if (mode === 'msf') {
        const [m, s, f] = IdeDrive.msf(lba);
        return [0, m, s, f];
      }
      return [lba >>> 24, (lba >> 16) & 0xff, (lba >> 8) & 0xff, lba & 0xff];
    };
    if (format === 0) {
      if (track > 1 && track !== 0xaa) {
        this.packetFail(ILLEGAL_REQUEST, ASC_INVALID_FIELD);
        return;
      }
      const data: number[] = [0, 0, 1, 1];
      if (track <= 1) data.push(0, 0x14, 1, 0, ...address(0));
      data.push(0, 0x16, 0xaa, 0, ...address(cd.sectorCount));
      data[1] = data.length - 2;
      this.packetReply(data, allowed);
      return;
    }
    if (format === 1) {
      this.packetReply([0, 10, 1, 1, 0, 0x14, 1, 0, ...address(0)], allowed);
      return;
    }
    // Format 2: the raw TOC, with the A0, A1 and A2 points and track 1.
    const [m, s, f] = IdeDrive.msf(cd.sectorCount);
    const data = [0, 0, 1, 1, 1, 0x14, 0, 0xa0, 0, 0, 0, 0, 1, 0, 0, 1, 0x14, 0, 0xa1, 0, 0, 0, 0, 1, 0, 0, 1, 0x14, 0, 0xa2, 0, 0, 0, 0, m, s, f, 1, 0x14, 0, 1, 0, 0, 0, 0, 0, 2, 0];
    data[1] = data.length - 2;
    this.packetReply(data, allowed);
  }

  private modeSense(ten: boolean, page: number, allowed: number): void {
    const pages: number[] = [];
    if (page === 0x2a || page === 0x3f) {
      // Capabilities: reads CD-ROM, has a tray that locks and ejects.
      pages.push(0x2a, 0x12, 0x00, 0x00, 0x71, 0x60, 0x29, 0x00, 0x02, 0xc2, 0x00, 0x02, 0x02, 0x00, 0x02, 0xc2, 0, 0, 0, 0);
    }
    if (page === 0x01 || page === 0x3f) pages.push(0x01, 0x06, 0, 5, 0, 0, 0, 0);
    if (page === 0x0d || page === 0x3f) pages.push(0x0d, 0x06, 0, 0, 0, 0x3c, 0, 0x4b);
    if (!pages.length) {
      this.packetFail(ILLEGAL_REQUEST, ASC_INVALID_FIELD);
      return;
    }
    const type = this.cd ? 0x01 : 0x70;
    const header = ten ? [0, pages.length + 6, type, 0, 0, 0, 0, 0] : [pages.length + 3, type, 0, 0];
    this.packetReply([...header, ...pages], allowed);
  }
}

/**
 * An IDE channel: the task file registers its master and slave drives share,
 * the device control register, and its interrupt line (IRQ 14 or 15).
 */
export class IdeChannel {
  readonly drives: (IdeDrive | null)[] = [null, null];
  feature = 0;
  count = 0;
  sector = 0;
  cylLow = 0;
  cylHigh = 0;
  select = 0xa0;
  devctrl = 0;
  private irqLevel = false;
  /** A step a drive is waiting to take, and when. */
  private pendingStep: (() => void) | null = null;
  nextEvent = Infinity;
  onIrq: (level: boolean) => void = () => {};

  constructor(readonly clock: Clock) {}

  attach(index: number, drive: IdeDrive | null): void {
    this.drives[index] = drive;
  }

  private get current(): IdeDrive | null {
    return this.drives[(this.select >> 4) & 1];
  }

  reset(): void {
    this.pendingStep = null;
    this.nextEvent = Infinity;
    this.select = 0xa0;
    this.devctrl = 0;
    for (const drive of this.drives) drive?.reset();
    this.select = 0xa0;
    this.updateIrq();
  }

  schedule(step: () => void, delayNs: number): void {
    this.pendingStep = step;
    this.nextEvent = this.clock.now() + delayNs;
  }

  update(now: number): void {
    if (now < this.nextEvent || !this.pendingStep) return;
    const step = this.pendingStep;
    this.pendingStep = null;
    this.nextEvent = Infinity;
    step();
  }

  updateIrq(): void {
    const drive = this.current;
    const level = !(this.devctrl & NIEN) && !!drive && drive.interrupt;
    if (level !== this.irqLevel) {
      this.irqLevel = level;
      this.onIrq(level);
    }
  }

  readRegister(reg: number): number {
    const drive = this.current;
    if (!drive) {
      // Nothing answers: an empty channel floats high; a missing slave reads as zero.
      return this.drives[0] || this.drives[1] ? (reg === 6 ? this.select : 0) : 0xff;
    }
    switch (reg) {
      case 1:
        return drive.error;
      case 2:
        return this.count;
      case 3:
        return this.sector;
      case 4:
        return this.cylLow;
      case 5:
        return this.cylHigh;
      case 6:
        return this.select;
      default:
        drive.interrupt = false;
        this.updateIrq();
        return drive.status;
    }
  }

  readAltStatus(): number {
    const drive = this.current;
    if (!drive) return this.drives[0] || this.drives[1] ? 0 : 0xff;
    return drive.status;
  }

  writeRegister(reg: number, value: number): void {
    switch (reg) {
      case 1:
        this.feature = value;
        return;
      case 2:
        this.count = value;
        return;
      case 3:
        this.sector = value;
        return;
      case 4:
        this.cylLow = value;
        return;
      case 5:
        this.cylHigh = value;
        return;
      case 6:
        this.select = value | 0xa0;
        this.updateIrq();
        return;
      default:
        this.current?.command(value);
    }
  }

  writeDeviceControl(value: number): void {
    const wasReset = (this.devctrl & SRST) !== 0;
    this.devctrl = value;
    if (value & SRST) {
      this.pendingStep = null;
      this.nextEvent = Infinity;
      for (const drive of this.drives) if (drive) drive.status = BSY;
    } else if (wasReset) {
      for (const drive of this.drives) drive?.reset();
      this.select = 0xa0;
      // The master's signature is what shows after a reset.
      (this.drives[0] ?? this.drives[1])?.reset();
    }
    this.updateIrq();
  }

  readData16(): number {
    return this.current?.readData16() ?? 0xffff;
  }

  writeData16(value: number): void {
    this.current?.writeData16(value);
  }

  get active(): boolean {
    return this.drives.some((drive) => drive?.active);
  }
}
