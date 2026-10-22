import type { Dma } from './dma';
import type { Clock } from './pit';

const SECTOR_BYTES = 512;
const DMA_CHANNEL = 2;
/** Commands finish this long after their last parameter. */
const COMMAND_NS = 200_000;
/** Stepping to another track takes this long per track (it matters little, so it's quick). */
const STEP_NS = 100_000;
const ACTIVITY_NS = 300_000_000;

/** Floppy formats by image size: tracks, sides, sectors per track. */
const FORMATS: [bytes: number, tracks: number, heads: number, sectors: number][] = [
  [163840, 40, 1, 8],
  [184320, 40, 1, 9],
  [327680, 40, 2, 8],
  [368640, 40, 2, 9],
  [737280, 80, 2, 9],
  [1228800, 80, 2, 15],
  [1474560, 80, 2, 18],
  [1720320, 80, 2, 21],
  [2949120, 80, 2, 36],
];

/** A floppy disk image (.img, .ima, .vfd): raw sectors, track by track. */
export class FloppyImage {
  readonly tracks: number;
  readonly heads: number;
  readonly sectors: number;
  dirty = false;

  constructor(
    readonly bytes: Uint8Array,
    readonly name: string,
  ) {
    const format = FORMATS.find(([size]) => size === bytes.length) ?? FORMATS.find(([size]) => size >= bytes.length);
    if (!format || bytes.length > 2949120) throw new Error('That file is not a floppy disk image (360K to 2.88 MB).');
    [, this.tracks, this.heads, this.sectors] = format;
    if (bytes.length < format[0]) {
      const padded = new Uint8Array(format[0]);
      padded.set(bytes);
      this.bytes = padded;
    }
  }

  offset(track: number, head: number, sector: number): number {
    return ((track * this.heads + head) * this.sectors + sector - 1) * SECTOR_BYTES;
  }
}

class Drive {
  disk: FloppyImage | null = null;
  track = 0;
  head = 0;
  /** Set when the disk is changed, until a step with a disk in. */
  changed = true;
  activeUntil = 0;
}

const enum Phase {
  Command,
  Execution,
  Result,
}

/** Parameter bytes each command takes (by its low five bits). */
const PARAMS: Record<number, number> = { 0x02: 8, 0x03: 2, 0x04: 1, 0x05: 8, 0x06: 8, 0x07: 1, 0x08: 0, 0x09: 8, 0x0a: 1, 0x0c: 8, 0x0d: 5, 0x0e: 0, 0x0f: 2, 0x10: 0, 0x11: 8, 0x12: 1, 0x13: 3, 0x14: 0, 0x18: 0, 0x19: 8, 0x1d: 8 };

/**
 * An 82077AA floppy disk controller with two drives: the digital output,
 * main status and data rate registers, the command/result FIFO, and the
 * commands DOS, the BIOS and Windows use, moving data by DMA channel 2 and
 * interrupting on IRQ 6.
 */
export class Fdc {
  readonly drives = [new Drive(), new Drive()];
  private dor = 0;
  private phase = Phase.Command;
  private command: number[] = [];
  private result: number[] = [];
  private expected = 0;
  /** Drives that finished a seek or recalibrate, waiting for SENSE INTERRUPT (as ST0 values). */
  private senseQueue: number[] = [];
  private irqLevel = false;
  private locked = false;
  private pendingStep: (() => void) | null = null;
  nextEvent = Infinity;
  onIrq: (level: boolean) => void = () => {};

  constructor(
    private readonly clock: Clock,
    private readonly dma: Dma,
  ) {}

  reset(): void {
    this.phase = Phase.Command;
    this.command = [];
    this.result = [];
    this.pendingStep = null;
    this.nextEvent = Infinity;
    this.senseQueue = [];
    this.setIrq(false);
  }

  insert(drive: number, disk: FloppyImage | null): void {
    this.drives[drive].disk = disk;
    this.drives[drive].changed = true;
  }

  get selected(): Drive {
    return this.drives[this.dor & 1];
  }

  private setIrq(level: boolean): void {
    if (level === this.irqLevel) return;
    this.irqLevel = level;
    this.onIrq(level);
  }

  private raiseIrq(): void {
    if (this.dor & 0x08) this.setIrq(true);
  }

  private schedule(step: () => void, delay = COMMAND_NS): void {
    this.pendingStep = step;
    this.nextEvent = this.clock.now() + delay;
  }

  update(now: number): void {
    if (now < this.nextEvent || !this.pendingStep) return;
    const step = this.pendingStep;
    this.pendingStep = null;
    this.nextEvent = Infinity;
    step();
  }

  // --- Registers -----------------------------------------------------------------------

  read(port: number): number {
    switch (port & 7) {
      case 2:
        return this.dor;
      case 4: {
        if (!(this.dor & 0x04)) return 0;
        if (this.phase === Phase.Execution) return 0x10;
        if (this.phase === Phase.Result) return 0xd0;
        return this.command.length ? 0x90 : 0x80;
      }
      case 5: {
        if (this.phase !== Phase.Result) return 0;
        const value = this.result.shift() ?? 0;
        if (this.result.length === 0) this.phase = Phase.Command;
        this.setIrq(false);
        return value;
      }
      case 7:
        return this.selected.changed ? 0x80 : 0;
      default:
        return 0;
    }
  }

  write(port: number, value: number): void {
    switch (port & 7) {
      case 2: {
        const wasReset = !(this.dor & 0x04);
        this.dor = value;
        if (!(value & 0x04)) {
          this.reset();
        } else if (wasReset) {
          // Leaving reset: each drive reports in through SENSE INTERRUPT.
          this.senseQueue = [0xc0, 0xc1, 0xc2, 0xc3];
          this.raiseIrq();
        }
        return;
      }
      case 4:
        if (value & 0x80) {
          this.reset();
          this.senseQueue = [0xc0, 0xc1, 0xc2, 0xc3];
          this.raiseIrq();
        }
        return;
      case 5:
        this.writeFifo(value);
        return;
    }
  }

  private writeFifo(value: number): void {
    if (this.phase !== Phase.Command) return;
    if (this.command.length === 0) {
      this.expected = PARAMS[value & 0x1f] ?? 0;
      if (value === 0x94 || value === 0x14) this.expected = 0;
    }
    this.command.push(value);
    if (this.command.length > this.expected) {
      const command = this.command;
      this.command = [];
      this.run(command);
    }
  }

  private finishWith(result: number[], irq = true): void {
    this.result = result;
    this.phase = result.length ? Phase.Result : Phase.Command;
    if (irq) this.raiseIrq();
  }

  // --- Commands --------------------------------------------------------------------------

  private run(c: number[]): void {
    const op = c[0] & 0x1f;
    switch (op) {
      case 0x03:
        this.finishWith([], false);
        return;
      case 0x04: {
        const drive = this.drives[c[1] & 1];
        const st3 = 0x20 | (drive.track === 0 ? 0x10 : 0) | (c[1] & 7) | (drive.disk ? 0 : 0);
        this.finishWith([st3], false);
        return;
      }
      case 0x07:
      case 0x0f: {
        const index = c[1] & 1;
        const drive = this.drives[index];
        const target = op === 0x07 ? 0 : c[2];
        drive.head = (c[1] >> 2) & 1;
        this.phase = Phase.Execution;
        this.schedule(() => {
          drive.track = target;
          if (drive.disk) drive.changed = false;
          this.senseQueue.push(0x20 | index | (drive.head << 2));
          this.finishWith([], true);
        }, Math.max(COMMAND_NS, Math.abs(target - drive.track) * STEP_NS));
        return;
      }
      case 0x08: {
        const st0 = this.senseQueue.shift();
        if (st0 === undefined) {
          this.finishWith([0x80], false);
          return;
        }
        if (this.senseQueue.length === 0) this.setIrq(false);
        this.finishWith([st0, this.drives[st0 & 1].track], false);
        return;
      }
      case 0x10:
        this.finishWith([0x90], false);
        return;
      case 0x12:
      case 0x13:
        this.finishWith([], false);
        return;
      case 0x14:
        this.locked = (c[0] & 0x80) !== 0;
        this.finishWith([this.locked ? 0x10 : 0], false);
        return;
      case 0x0e: {
        const [d0, d1] = this.drives;
        this.finishWith([d0.track, d1.track, 0, 0, 0xaf, 0x02, 18, 0, this.locked ? 0x80 : 0, 0], false);
        return;
      }
      case 0x18:
        this.finishWith([0x41], false);
        return;
      case 0x0a: {
        const index = c[1] & 1;
        const drive = this.drives[index];
        const head = (c[1] >> 2) & 1;
        this.phase = Phase.Execution;
        this.schedule(() => {
          if (!drive.disk) this.finishWith([0x40 | index | (head << 2), 0x01, 0, drive.track, head, 1, 2]);
          else this.finishWith([index | (head << 2), 0, 0, drive.track, head, 1, 2]);
        });
        return;
      }
      case 0x06:
      case 0x0c:
      case 0x05:
      case 0x09:
        this.phase = Phase.Execution;
        this.schedule(() => this.transfer(c, op === 0x05 || op === 0x09));
        return;
      case 0x0d:
        this.phase = Phase.Execution;
        this.schedule(() => this.format(c));
        return;
      default:
        this.finishWith([0x80], false);
    }
  }

  /** READ DATA and WRITE DATA: sectors R to EOT (and the other side with MT), through DMA. */
  private transfer(c: number[], write: boolean): void {
    const index = c[1] & 1;
    const drive = this.drives[index];
    let head = (c[1] >> 2) & 1;
    let track = c[2];
    let sector = c[4];
    const sizeCode = c[5];
    const eot = c[6];
    const multiTrack = (c[0] & 0x80) !== 0;
    const disk = drive.disk;
    const st0Base = index | (head << 2);
    drive.activeUntil = this.clock.now() + ACTIVITY_NS;
    if (!disk) {
      this.finishWith([0x40 | st0Base | 0x08, 0x05, 0, track, head, sector, sizeCode]);
      return;
    }
    if (track >= disk.tracks || head >= disk.heads || sizeCode !== 2) {
      this.finishWith([0x40 | st0Base, 0x04, 0, track, head, sector, sizeCode]);
      return;
    }
    drive.track = track;
    const buffer = new Uint8Array(SECTOR_BYTES);
    let terminal = false;
    for (;;) {
      if (sector > disk.sectors || sector < 1) {
        this.finishWith([0x40 | index | (head << 2), 0x04, 0, track, head, sector, sizeCode]);
        return;
      }
      const at = disk.offset(track, head, sector);
      if (write) {
        const moved = this.dma.readMemory(DMA_CHANNEL, buffer, 0, SECTOR_BYTES, () => (terminal = true));
        if (moved === 0) break;
        disk.bytes.set(buffer, at);
        disk.dirty = true;
      } else {
        buffer.set(disk.bytes.subarray(at, at + SECTOR_BYTES));
        const moved = this.dma.writeMemory(DMA_CHANNEL, buffer, 0, SECTOR_BYTES, () => (terminal = true));
        if (moved === 0) break;
      }
      // Move to the next sector; after EOT, the other side (multi-track) or the next cylinder.
      if (sector === eot) {
        sector = 1;
        if (multiTrack && head === 0 && disk.heads > 1) {
          head = 1;
          if (terminal) break;
          continue;
        }
        if (multiTrack) head = 0;
        track++;
        break;
      }
      sector++;
      if (terminal) break;
    }
    this.finishWith([index | (head << 2), 0, 0, track, head, sector, sizeCode]);
  }

  /** FORMAT TRACK: the sector IDs come by DMA; every sector is filled with the given byte. */
  private format(c: number[]): void {
    const index = c[1] & 1;
    const drive = this.drives[index];
    const head = (c[1] >> 2) & 1;
    const count = c[3];
    const fill = c[5];
    const disk = drive.disk;
    if (!disk) {
      this.finishWith([0x40 | index | (head << 2) | 0x08, 0x05, 0, drive.track, head, 1, 2]);
      return;
    }
    const id = new Uint8Array(4);
    for (let i = 0; i < count; i++) {
      if (this.dma.readMemory(DMA_CHANNEL, id, 0, 4) < 4) break;
      const [track, h, sector] = id;
      if (track < disk.tracks && h < disk.heads && sector >= 1 && sector <= disk.sectors) {
        const at = disk.offset(track, h, sector);
        disk.bytes.fill(fill, at, at + SECTOR_BYTES);
        disk.dirty = true;
      }
    }
    this.finishWith([index | (head << 2), 0, 0, drive.track, head, 1, 2]);
  }
}
