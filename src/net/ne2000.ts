// Command register bits.
const CR_STOP = 0x01;
const CR_TRANSMIT = 0x04;
const CR_REMOTE_READ = 0x08;
const CR_REMOTE_WRITE = 0x10;

// Interrupt status bits.
const ISR_RX = 0x01;
const ISR_TX = 0x02;
const ISR_REMOTE_DONE = 0x40;
const ISR_RESET = 0x80;

const TSR_TRANSMITTED = 0x01;
const RSR_RECEIVED = 0x01;
const RSR_MULTICAST = 0x20;

// Receive configuration bits.
const RCR_BROADCAST = 0x04;
const RCR_MULTICAST = 0x08;
const RCR_PROMISCUOUS = 0x10;

/** The card's packet memory: 32 KB at 4000h-BFFFh; the address PROM shows at 0-1Fh. */
const MEMORY_START = 0x4000;
const MEMORY_END = 0xc000;
const PROM_BYTES = 32;
const MIN_FRAME = 60;
const MAX_FRAME = 1514;
/** Frames arriving while the ring is full wait here (beyond it they are dropped, like on a busy wire). */
const MAX_WAITING = 64;

/** The DP8390's multicast filter index: the top six bits of the destination address's CRC, computed most significant bit first. */
function multicastIndex(frame: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < 6; i++) {
    let byte = frame[i];
    for (let bit = 0; bit < 8; bit++) {
      const carry = (crc >>> 31) ^ (byte & 1);
      crc = (crc << 1) >>> 0;
      byte >>= 1;
      if (carry) crc = ((crc ^ 0x04c11db6) | 1) >>> 0;
    }
  }
  return crc >>> 26;
}

/**
 * An NE2000-compatible network card: a DP8390 with 32 KB of packet memory,
 * reached through the remote DMA data port, with the Realtek chips' ID and
 * configuration registers. DOS, Windows 3.1, 95, 98 and NT all have drivers
 * for it. Registers are at base + 0-0Fh in four pages, the data port at
 * base + 10h and the reset port at base + 1Fh. Frames go out through
 * `onTransmit` and come in by `receive`.
 */
export class Ne2000 {
  private readonly memory = new Uint8Array(MEMORY_END);
  private command = CR_STOP;
  private pageStart = MEMORY_START;
  private pageStop = MEMORY_END;
  private boundary = 0;
  private transmitPage = 0;
  private transmitCount = 0;
  private remoteAddress = 0;
  private remoteCount = 0;
  private receiveConfig = 0;
  private transmitConfig = 0;
  private dataConfig = 0;
  private interruptMask = 0;
  private interruptStatus = ISR_RESET;
  private transmitStatus = 0;
  private receiveStatus = 0;
  private currentPage = 0;
  private readonly physical = new Uint8Array(6);
  private readonly multicast = new Uint8Array(8);
  private readonly waiting: Uint8Array[] = [];
  /** The interrupt line (INTA on PCI). */
  onIrq: (level: boolean) => void = () => {};
  /** Called with each frame the card sends (without its CRC). */
  onTransmit: (frame: Uint8Array<ArrayBuffer>) => void = () => {};

  constructor(readonly mac: Uint8Array) {
    this.reset();
  }

  reset(): void {
    this.command = CR_STOP;
    this.interruptStatus = ISR_RESET;
    this.interruptMask = 0;
    this.waiting.length = 0;
    // The address PROM: the MAC address, then 57h 57h (the word-mode signature drivers look for), each byte doubled.
    const prom = new Uint8Array(16);
    prom.set(this.mac);
    prom[14] = prom[15] = 0x57;
    for (let i = 0; i < 16; i++) this.memory[i * 2] = this.memory[i * 2 + 1] = prom[i];
    this.updateIrq();
  }

  private updateIrq(): void {
    this.onIrq((this.interruptStatus & this.interruptMask & 0x7f) !== 0);
  }

  read(offset: number): number {
    if (offset >= 0x10) return offset === 0x1f ? this.softReset() : this.readData(this.wordMode ? 2 : 1);
    if (offset === 0) return this.command;
    const page = this.command >> 6;
    if (page === 1) {
      if (offset < 7) return this.physical[offset - 1];
      if (offset === 7) return this.currentPage;
      return this.multicast[offset - 8];
    }
    if (page === 2) {
      switch (offset) {
        case 1:
          return this.pageStart >> 8;
        case 2:
          return this.pageStop >> 8;
        case 4:
          return this.transmitPage;
        case 0x0c:
          return this.receiveConfig;
        case 0x0d:
          return this.transmitConfig;
        case 0x0e:
          return this.dataConfig;
        case 0x0f:
          return this.interruptMask;
      }
      return 0;
    }
    if (page === 3) {
      // RTL8029 configuration: 10BASE-T, link up, full duplex.
      if (offset === 5 || offset === 6) return 0x40;
      return 0;
    }
    switch (offset) {
      case 3:
        return this.boundary;
      case 4:
        return this.transmitStatus;
      case 7:
        return this.interruptStatus;
      case 8:
        return this.remoteAddress & 0xff;
      case 9:
        return this.remoteAddress >> 8;
      // The RTL8029's ID, "PC".
      case 0x0a:
        return 0x50;
      case 0x0b:
        return 0x43;
      case 0x0c:
        return this.receiveStatus;
    }
    return 0;
  }

  write(offset: number, value: number): void {
    if (offset >= 0x10) {
      if (offset < 0x1f) this.writeData(value, this.wordMode ? 2 : 1);
      return;
    }
    if (offset === 0) {
      this.writeCommand(value);
      return;
    }
    const page = this.command >> 6;
    if (page === 1) {
      if (offset < 7) this.physical[offset - 1] = value;
      else if (offset === 7) this.currentPage = value;
      else this.multicast[offset - 8] = value;
      if (offset === 7) this.deliverWaiting();
      return;
    }
    if (page !== 0) return;
    switch (offset) {
      case 1:
        this.pageStart = value << 8;
        break;
      case 2:
        this.pageStop = value << 8;
        break;
      case 3:
        this.boundary = value;
        this.deliverWaiting();
        break;
      case 4:
        this.transmitPage = value;
        break;
      case 5:
        this.transmitCount = (this.transmitCount & 0xff00) | value;
        break;
      case 6:
        this.transmitCount = (this.transmitCount & 0xff) | (value << 8);
        break;
      case 7:
        this.interruptStatus &= ~(value & 0x7f);
        this.updateIrq();
        break;
      case 8:
        this.remoteAddress = (this.remoteAddress & 0xff00) | value;
        break;
      case 9:
        this.remoteAddress = (this.remoteAddress & 0xff) | (value << 8);
        break;
      case 0x0a:
        this.remoteCount = (this.remoteCount & 0xff00) | value;
        break;
      case 0x0b:
        this.remoteCount = (this.remoteCount & 0xff) | (value << 8);
        break;
      case 0x0c:
        this.receiveConfig = value;
        break;
      case 0x0d:
        this.transmitConfig = value;
        break;
      case 0x0e:
        this.dataConfig = value;
        break;
      case 0x0f:
        this.interruptMask = value;
        this.updateIrq();
        break;
    }
  }

  private writeCommand(value: number): void {
    this.command = value;
    if (value & CR_STOP) return;
    this.interruptStatus &= ~ISR_RESET;
    // A remote DMA of no bytes completes at once.
    if (value & (CR_REMOTE_READ | CR_REMOTE_WRITE) && this.remoteCount === 0) {
      this.interruptStatus |= ISR_REMOTE_DONE;
      this.updateIrq();
    }
    if (value & CR_TRANSMIT) {
      let start = this.transmitPage << 8;
      if (start >= MEMORY_END) start -= MEMORY_END - MEMORY_START;
      if (start + this.transmitCount <= MEMORY_END) this.onTransmit(this.memory.slice(start, start + this.transmitCount));
      this.transmitStatus = TSR_TRANSMITTED;
      this.interruptStatus |= ISR_TX;
      this.command &= ~CR_TRANSMIT;
      this.updateIrq();
    }
    this.deliverWaiting();
  }

  /** Whether the data port moves words (the data configuration's WTS bit). */
  private get wordMode(): boolean {
    return (this.dataConfig & 1) !== 0;
  }

  private softReset(): number {
    this.reset();
    return 0;
  }

  private inMemory(address: number): boolean {
    return address < PROM_BYTES || (address >= MEMORY_START && address < MEMORY_END);
  }

  /** Reads `bytes` (1, 2 or 4) through the remote DMA data port. */
  readData(bytes: number): number {
    let value = 0;
    let address = this.remoteAddress;
    if (bytes > 1) address &= ~1;
    for (let i = 0; i < bytes; i++) value |= (this.inMemory(address + i) ? this.memory[address + i] : 0xff) << (i * 8);
    this.advanceRemote(bytes);
    return value >>> 0;
  }

  writeData(value: number, bytes: number): void {
    if (this.remoteCount === 0) return;
    let address = this.remoteAddress;
    if (bytes > 1) address &= ~1;
    for (let i = 0; i < bytes; i++) if (this.inMemory(address + i)) this.memory[address + i] = (value >>> (i * 8)) & 0xff;
    this.advanceRemote(bytes);
  }

  private advanceRemote(bytes: number): void {
    this.remoteAddress = (this.remoteAddress + bytes) & 0xffff;
    if (this.remoteAddress === this.pageStop) this.remoteAddress = this.pageStart;
    if (this.remoteCount <= bytes) {
      this.remoteCount = 0;
      this.interruptStatus |= ISR_REMOTE_DONE;
      this.updateIrq();
    } else {
      this.remoteCount -= bytes;
    }
  }

  // --- Receiving -------------------------------------------------------------------------

  /** A frame from the network (without its CRC). */
  receive(frame: Uint8Array): void {
    if (!this.accepts(frame)) return;
    if (this.waiting.length || !this.store(frame)) {
      if (this.waiting.length < MAX_WAITING) this.waiting.push(frame);
    }
  }

  private accepts(frame: Uint8Array): boolean {
    if (frame.length < 14 || frame.length > MAX_FRAME) return false;
    if (this.receiveConfig & RCR_PROMISCUOUS) return true;
    if (frame.subarray(0, 6).every((byte) => byte === 0xff)) return (this.receiveConfig & RCR_BROADCAST) !== 0;
    if (frame[0] & 1) {
      if (!(this.receiveConfig & RCR_MULTICAST)) return false;
      const index = multicastIndex(frame);
      return (this.multicast[index >> 3] & (1 << (index & 7))) !== 0;
    }
    return frame.subarray(0, 6).every((byte, i) => byte === this.physical[i]);
  }

  private deliverWaiting(): void {
    while (this.waiting.length && this.store(this.waiting[0])) this.waiting.shift();
  }

  private ringFree(): number {
    const index = this.currentPage << 8;
    const boundary = this.boundary << 8;
    return index < boundary ? boundary - index : this.pageStop - this.pageStart - (index - boundary);
  }

  /** Puts a frame in the receive ring, behind a 4-byte header; false if the card is stopped or the ring is full. */
  private store(frame: Uint8Array): boolean {
    if (this.command & CR_STOP || this.pageStop <= this.pageStart || this.ringFree() < MAX_FRAME + 4) return false;
    let data = frame;
    if (data.length < MIN_FRAME) {
      data = new Uint8Array(MIN_FRAME);
      data.set(frame);
    }
    let index = this.currentPage << 8;
    if (index >= MEMORY_END || index < this.pageStart) index = this.pageStart;
    const total = data.length + 4;
    let next = index + ((total + 4 + 255) & ~0xff);
    if (next >= this.pageStop) next -= this.pageStop - this.pageStart;
    this.receiveStatus = RSR_RECEIVED | (data[0] & 1 ? RSR_MULTICAST : 0);
    this.memory[index] = this.receiveStatus;
    this.memory[index + 1] = next >> 8;
    this.memory[index + 2] = total & 0xff;
    this.memory[index + 3] = total >> 8;
    index += 4;
    let offset = 0;
    while (offset < data.length) {
      const length = Math.min(data.length - offset, this.pageStop - index);
      this.memory.set(data.subarray(offset, offset + length), index);
      offset += length;
      index += length;
      if (index >= this.pageStop) index = this.pageStart;
    }
    this.currentPage = next >> 8;
    this.interruptStatus |= ISR_RX;
    this.updateIrq();
    return true;
  }
}
