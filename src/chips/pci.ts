/** A base address register: its size (a power of two) and whether it's I/O or memory space. */
export interface PciBar {
  size: number;
  io: boolean;
  prefetchable?: boolean;
}

/** One PCI function's configuration space. */
export class PciFunction {
  readonly config = new Uint8Array(256);
  /** BARs 0-5 (undefined for none); `rom` is the expansion ROM BAR. */
  readonly bars: (PciBar | undefined)[] = [];
  rom: PciBar | undefined;
  /** Called after the guest writes the configuration space. */
  onWrite: (offset: number) => void = () => {};

  constructor(vendor: number, device: number, classCode: number, revision = 0, headerType = 0) {
    const view = new DataView(this.config.buffer);
    view.setUint16(0, vendor, true);
    view.setUint16(2, device, true);
    view.setUint32(8, (classCode << 8) | revision, true);
    this.config[0x0e] = headerType;
  }

  read32(offset: number): number {
    return new DataView(this.config.buffer).getUint32(offset & 0xfc, true);
  }

  /** The address a BAR currently decodes (0 if unassigned). */
  barAddress(index: number): number {
    const bar = this.bars[index];
    if (!bar) return 0;
    const value = this.read32(0x10 + index * 4);
    return (bar.io ? value & ~3 : value & ~0xf) >>> 0;
  }

  get romAddress(): number {
    const value = this.read32(0x30);
    return value & 1 ? (value & ~0x7ff) >>> 0 : 0;
  }

  get memoryEnabled(): boolean {
    return (this.config[4] & 2) !== 0;
  }

  get ioEnabled(): boolean {
    return (this.config[4] & 1) !== 0;
  }

  /** A configuration write of `size` bytes, honouring read-only fields and BAR sizes. */
  write(offset: number, value: number, size: number): void {
    for (let i = 0; i < size; i++) {
      const at = offset + i;
      const byte = (value >>> (i * 8)) & 0xff;
      if (at < 4 || (at >= 8 && at < 0x0c) || at === 0x0e || (at >= 0x2c && at < 0x30) || at === 0x3d) continue;
      this.config[at] = byte;
    }
    const view = new DataView(this.config.buffer);
    for (let index = 0; index < 6; index++) {
      const reg = 0x10 + index * 4;
      if (offset + size <= reg || offset >= reg + 4) continue;
      const bar = this.bars[index];
      if (!bar) {
        view.setUint32(reg, 0, true);
        continue;
      }
      const raw = view.getUint32(reg, true);
      const flags = bar.io ? 1 : bar.prefetchable ? 8 : 0;
      view.setUint32(reg, ((raw & ~(bar.size - 1) & ~0xf) | flags) >>> 0, true);
    }
    if (offset < 0x34 && offset + size > 0x30) {
      const raw = view.getUint32(0x30, true);
      view.setUint32(0x30, this.rom ? ((raw & ~(this.rom.size - 1) & ~0x7fe) | (raw & 1)) >>> 0 : 0, true);
    }
    this.onWrite(offset);
  }
}

/**
 * PCI bus 0 with configuration mechanism #1 (ports CF8h and CFCh-CFFh).
 * Functions are added at device numbers; a device's function 0 says, in its
 * header type, whether there are others.
 */
export class PciBus {
  private address = 0;
  private readonly functions = new Map<number, PciFunction>();

  add(device: number, fn: number, pci: PciFunction): void {
    this.functions.set((device << 3) | fn, pci);
  }

  get all(): PciFunction[] {
    return [...this.functions.values()];
  }

  private selected(): PciFunction | undefined {
    if (!(this.address & 0x80000000)) return undefined;
    if ((this.address >> 16) & 0xff) return undefined;
    return this.functions.get((this.address >> 8) & 0xff);
  }

  readAddress(): number {
    return this.address;
  }

  writeAddress(value: number): void {
    this.address = value & 0x80fffffc;
  }

  /** A read of the data window (port CFCh + `offset`, `size` bytes). */
  readData(offset: number, size: number): number {
    const fn = this.selected();
    if (!fn) return size === 4 ? -1 : (1 << (size * 8)) - 1;
    const at = (this.address & 0xfc) + offset;
    let value = 0;
    for (let i = 0; i < size; i++) value |= fn.config[at + i] << (i * 8);
    return value;
  }

  writeData(offset: number, value: number, size: number): void {
    this.selected()?.write((this.address & 0xfc) + offset, value, size);
  }
}
