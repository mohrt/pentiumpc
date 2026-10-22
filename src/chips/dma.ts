/** The page register port for each channel. */
const PAGE_PORTS = [0x87, 0x83, 0x81, 0x82, 0x8f, 0x8b, 0x89, 0x8a];

class DmaChannel {
  baseAddress = 0;
  baseCount = 0;
  address = 0;
  count = 0;
  mode = 0;
  page = 0;
  masked = true;

  get autoInit(): boolean {
    return (this.mode & 0x10) !== 0;
  }

  get decrement(): boolean {
    return (this.mode & 0x20) !== 0;
  }
}

/** Physical memory as the DMA controllers see it. */
export interface DmaMemory {
  readonly ram: Uint8Array;
}

/**
 * The PC's two 8237 DMA controllers: channels 0-3 move bytes, 4-7 words
 * (channel 4 cascades the first controller). Devices ask for transfers with
 * `read` (memory to device) and `write` (device to memory); a channel that
 * reaches its terminal count stops, or reloads in auto-initialize mode.
 */
export class Dma {
  readonly channels = Array.from({ length: 8 }, () => new DmaChannel());
  private flipFlop = [false, false];
  /** Terminal count reached (bits 0-3) per controller. */
  private status = [0, 0];
  /** The last POST code written to port 80h. */
  postCode = 0;

  constructor(private readonly memory: DmaMemory) {}

  reset(): void {
    for (const c of this.channels) {
      c.masked = true;
      c.mode = 0;
    }
    this.flipFlop = [false, false];
    this.status = [0, 0];
  }

  /** Port numbers 00-0F, C0-DF and the page registers 80-8F. */
  write(port: number, value: number): void {
    if (port >= 0x80 && port <= 0x8f) {
      if (port === 0x80) this.postCode = value;
      const channel = PAGE_PORTS.indexOf(port);
      if (channel >= 0) this.channels[channel].page = value;
      return;
    }
    const high = port >= 0xc0;
    const reg = high ? (port - 0xc0) >> 1 : port;
    const first = high ? 4 : 0;
    const ctrl = high ? 1 : 0;
    if (reg < 8) {
      const c = this.channels[first + (reg >> 1)];
      const byteHigh = this.flipFlop[ctrl];
      this.flipFlop[ctrl] = !byteHigh;
      const shift = byteHigh ? 8 : 0;
      if (reg & 1) {
        c.baseCount = (c.baseCount & ~(0xff << shift)) | (value << shift);
        c.count = c.baseCount;
      } else {
        c.baseAddress = (c.baseAddress & ~(0xff << shift)) | (value << shift);
        c.address = c.baseAddress;
      }
      return;
    }
    switch (reg) {
      case 0x0a:
        this.channels[first + (value & 3)].masked = (value & 4) !== 0;
        return;
      case 0x0b:
        this.channels[first + (value & 3)].mode = value;
        return;
      case 0x0c:
        this.flipFlop[ctrl] = false;
        return;
      case 0x0d:
        this.flipFlop[ctrl] = false;
        this.status[ctrl] = 0;
        for (let i = 0; i < 4; i++) this.channels[first + i].masked = true;
        return;
      case 0x0e:
        for (let i = 0; i < 4; i++) this.channels[first + i].masked = false;
        return;
      case 0x0f:
        for (let i = 0; i < 4; i++) this.channels[first + i].masked = (value & (1 << i)) !== 0;
        return;
    }
  }

  read(port: number): number {
    if (port >= 0x80 && port <= 0x8f) {
      const channel = PAGE_PORTS.indexOf(port);
      return channel >= 0 ? this.channels[channel].page : port === 0x80 ? this.postCode : 0;
    }
    const high = port >= 0xc0;
    const reg = high ? (port - 0xc0) >> 1 : port;
    const first = high ? 4 : 0;
    const ctrl = high ? 1 : 0;
    if (reg < 8) {
      const c = this.channels[first + (reg >> 1)];
      const byteHigh = this.flipFlop[ctrl];
      this.flipFlop[ctrl] = !byteHigh;
      const value = reg & 1 ? c.count : c.address;
      return (byteHigh ? value >> 8 : value) & 0xff;
    }
    if (reg === 0x08) {
      const value = this.status[ctrl];
      this.status[ctrl] = 0;
      return value;
    }
    return 0;
  }

  /** Whether a channel is unmasked, so a device may transfer. */
  ready(channel: number): boolean {
    return !this.channels[channel].masked;
  }

  /** Bytes left in the transfer on a channel. */
  remaining(channel: number): number {
    const c = this.channels[channel];
    return (c.count + 1) * (channel >= 4 ? 2 : 1);
  }

  private physical(channel: number, c: DmaChannel): number {
    if (channel >= 4) return ((c.page & 0xfe) << 16) | ((c.address << 1) & 0x1ffff);
    return (c.page << 16) | c.address;
  }

  private step(channel: number, c: DmaChannel): boolean {
    c.address = (c.address + (c.decrement ? -1 : 1)) & 0xffff;
    if (c.count === 0) {
      this.status[channel >> 2] |= 1 << (channel & 3);
      if (c.autoInit) {
        c.address = c.baseAddress;
        c.count = c.baseCount;
      } else {
        c.count = 0xffff;
        c.masked = true;
      }
      return true;
    }
    c.count--;
    return false;
  }

  /**
   * Moves up to `length` bytes from memory to a device; returns how many it
   * moved (stopping at the terminal count, which `onTerminal` reports).
   */
  readMemory(channel: number, into: Uint8Array, offset: number, length: number, onTerminal?: () => void): number {
    const c = this.channels[channel];
    const ram = this.memory.ram;
    const wide = channel >= 4;
    let moved = 0;
    while (moved < length && !c.masked) {
      const p = this.physical(channel, c);
      into[offset + moved] = p < ram.length ? ram[p] : 0xff;
      if (wide) into[offset + moved + 1] = p + 1 < ram.length ? ram[p + 1] : 0xff;
      moved += wide ? 2 : 1;
      if (this.step(channel, c)) {
        onTerminal?.();
        if (!c.autoInit) break;
      }
    }
    return moved;
  }

  /** Moves up to `length` bytes from a device into memory; returns how many it moved. */
  writeMemory(channel: number, from: Uint8Array, offset: number, length: number, onTerminal?: () => void): number {
    const c = this.channels[channel];
    const ram = this.memory.ram;
    const wide = channel >= 4;
    let moved = 0;
    while (moved < length && !c.masked) {
      const p = this.physical(channel, c);
      if (p < ram.length) ram[p] = from[offset + moved];
      if (wide && p + 1 < ram.length) ram[p + 1] = from[offset + moved + 1];
      moved += wide ? 2 : 1;
      if (this.step(channel, c)) {
        onTerminal?.();
        if (!c.autoInit) break;
      }
    }
    return moved;
  }
}
