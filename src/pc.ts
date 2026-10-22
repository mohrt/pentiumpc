import { Fdc, type FloppyImage } from './chips/fdc';
import { Dma } from './chips/dma';
import { I8042 } from './chips/i8042';
import { PciBus, PciFunction } from './chips/pci';
import { Pics } from './chips/pic';
import { Pit, type Clock } from './chips/pit';
import { Rtc, type BootDevice } from './chips/rtc';
import { Cpu, type CpuHost } from './cpu/cpu';
import { IdeChannel, IdeDrive, type CdImage } from './ide/ide';
import type { HardDiskImage } from './ide/image';
import { VRAM_BYTES, Vga } from './video/vga';

/** Emulated time per instruction: a 100 MHz Pentium running about one instruction a clock. */
export const CYCLE_NS = 10;
/** The CPU runs at most this many instructions between device updates. */
const MAX_SLICE = 20_000;
const VGA_WINDOW_START = 0xa0000;
const VGA_WINDOW_END = 0xc0000;
const VGA_ROM_SIZE = 0x10000;

export interface MachineConfig {
  /** RAM in megabytes. */
  memoryMb: number;
  bootOrder: BootDevice[];
}

/** The Windows 98 preset's machine (machines.ts has all the presets). */
export const DEFAULT_CONFIG: MachineConfig = { memoryMb: 64, bootOrder: ['hd', 'cdrom', 'floppy'] };

type Reader = (port: number) => number;
type Writer = (port: number, value: number) => void;

/**
 * A Pentium PC of the late 1990s, for DOS, Windows 3.1, 95 and 98 and the other systems of the time: an
 * i440FX chipset with a PIIX3 south bridge (two 8259 PICs, an 8254 PIT,
 * two 8237 DMA controllers, the RTC and CMOS), an 8042 keyboard
 * controller with a PS/2 keyboard and mouse, a floppy controller, two IDE
 * channels (a hard disk and a CD-ROM drive), and a Bochs VBE graphics card
 * on PCI. SeaBIOS is the firmware.
 */
export class Pc implements CpuHost, Clock {
  /** RAM followed by the video memory, so the CPU can reach the frame buffer directly. */
  ram: Uint8Array;
  ramBytes: number;
  readonly cpu: Cpu;
  readonly pics = new Pics();
  readonly pit: Pit;
  readonly rtc: Rtc;
  readonly dma: Dma;
  readonly kbc: I8042;
  readonly fdc: Fdc;
  readonly ide: [IdeChannel, IdeChannel];
  vga: Vga;
  readonly pci = new PciBus();
  readonly vgaPci: PciFunction;
  private bios: Uint8Array = new Uint8Array(0);
  private vgaBios: Uint8Array = new Uint8Array(0);
  config: MachineConfig = DEFAULT_CONFIG;
  /** SeaBIOS's debug output (port 402h). */
  debugLog = '';
  private readonly readers8: (Reader | undefined)[] = new Array(0x10000);
  private readonly writers8: (Writer | undefined)[] = new Array(0x10000);
  private readonly readers16: (Reader | undefined)[] = new Array(0x10000);
  private readonly writers16: (Writer | undefined)[] = new Array(0x10000);
  private readonly readers32: (Reader | undefined)[] = new Array(0x10000);
  private readonly writers32: (Writer | undefined)[] = new Array(0x10000);
  private a20Keyboard = false;
  private a20Fast = false;
  private portB = 0;
  private resetPending = false;
  /** Cycles skipped while the CPU was halted (so cycles minus these were instructions run). */
  idleCycles = 0;
  /** Called when the guest resets the machine (after the reset is done). */
  onReset: () => void = () => {};

  constructor(config: MachineConfig = DEFAULT_CONFIG) {
    this.config = config;
    this.ramBytes = config.memoryMb << 20;
    this.ram = new Uint8Array(this.ramBytes + VRAM_BYTES);
    this.cpu = new Cpu(this);
    this.pit = new Pit(this);
    this.rtc = new Rtc(this);
    const ram = () => this.ram.subarray(0, this.ramBytes);
    this.dma = new Dma({
      get ram() {
        return ram();
      },
    });
    this.dma.onMemoryWrite = (address) => this.cpu.memoryWritten(address);
    this.kbc = new I8042(this);
    this.fdc = new Fdc(this, this.dma);
    this.ide = [new IdeChannel(this), new IdeChannel(this)];
    this.vga = new Vga(this, this.ram, this.ramBytes);

    this.pics.onChange = (level) => (this.cpu.irqLine = level);
    this.pit.onIrq = () => this.pics.pulseIrq(0);
    this.rtc.onIrq = (level) => this.pics.setIrq(8, level);
    this.kbc.onIrq1 = (level) => this.pics.setIrq(1, level);
    this.kbc.onIrq12 = (level) => this.pics.setIrq(12, level);
    this.kbc.onA20 = (enabled) => {
      this.a20Keyboard = enabled;
      this.updateA20();
    };
    this.kbc.onReset = () => (this.resetPending = true);
    this.fdc.onIrq = (level) => this.pics.setIrq(6, level);
    this.ide[0].onIrq = (level) => this.pics.setIrq(14, level);
    this.ide[1].onIrq = (level) => this.pics.setIrq(15, level);

    // PCI: the host bridge, the PIIX3's ISA bridge and IDE functions, and the graphics card.
    const host = new PciFunction(0x8086, 0x1237, 0x060000, 0x02);
    // QEMU's subsystem ID, which SeaBIOS looks for to know the machine.
    host.config.set([0xf4, 0x1a, 0x00, 0x11], 0x2c);
    const isa = new PciFunction(0x8086, 0x7000, 0x060100, 0x00, 0x80);
    isa.config.set([0x80, 0x80, 0x80, 0x80], 0x60);
    const ideFn = new PciFunction(0x8086, 0x7010, 0x010180, 0x00);
    this.vgaPci = new PciFunction(0x1234, 0x1111, 0x030000, 0x02);
    this.vgaPci.bars[0] = { size: VRAM_BYTES, io: false, prefetchable: true };
    this.vgaPci.rom = { size: VGA_ROM_SIZE, io: false };
    this.vgaPci.config.set([0xf4, 0x1a, 0x00, 0x11], 0x2c);
    this.vgaPci.onWrite = () => {
      const address = this.vgaPci.barAddress(0);
      if (address) this.vga.lfbAddress = address;
      this.cpu.flushTlb();
    };
    this.pci.add(0, 0, host);
    this.pci.add(1, 0, isa);
    this.pci.add(1, 1, ideFn);
    this.pci.add(2, 0, this.vgaPci);

    this.mapPorts();
  }

  // --- Clock ---------------------------------------------------------------------------

  now(): number {
    return this.cpu.cycles * CYCLE_NS;
  }

  // --- Media ---------------------------------------------------------------------------

  /** Puts a hard disk on the primary channel's master (null for none); takes effect at the next power on. */
  attachHardDisk(image: HardDiskImage | null): void {
    this.ide[0].attach(0, image ? new IdeDrive(this.ide[0], image, null, false) : null);
  }

  /** The CD-ROM drive is the secondary channel's master. */
  get cdrom(): IdeDrive {
    let drive = this.ide[1].drives[0];
    if (!drive) {
      drive = new IdeDrive(this.ide[1], null, null, true);
      this.ide[1].attach(0, drive);
    }
    return drive;
  }

  insertCd(image: CdImage | null): void {
    this.cdrom.changeMedia(image);
  }

  insertFloppy(drive: number, image: FloppyImage | null): void {
    this.fdc.insert(drive, image);
  }

  get hardDisk(): HardDiskImage | null {
    return this.ide[0].drives[0]?.disk ?? null;
  }

  // --- Power ---------------------------------------------------------------------------

  /** The firmware: SeaBIOS (128 or 256 KB) and the VGA BIOS for the graphics card's ROM. */
  setFirmware(bios: Uint8Array, vgaBios: Uint8Array): void {
    this.bios = bios;
    this.vgaBios = vgaBios;
  }

  setConfig(config: MachineConfig): void {
    this.config = config;
    const bytes = config.memoryMb << 20;
    if (bytes !== this.ramBytes) {
      this.ramBytes = bytes;
      this.ram = new Uint8Array(bytes + VRAM_BYTES);
      this.vga = new Vga(this, this.ram, bytes);
      this.cpu.attachRam();
    }
  }

  /** Switches on: memory cleared, the CMOS set up, everything reset. */
  powerOn(localSeconds = Date.now() / 1000 - new Date().getTimezoneOffset() * 60): void {
    this.ram.fill(0);
    void this.cdrom;
    this.rtc.powerOn({ memory: this.ramBytes, bootOrder: this.config.bootOrder, floppy: true }, localSeconds);
    this.debugLog = '';
    this.reset();
  }

  /** The reset line: CPU and devices restart; memory keeps its contents (but the BIOS is copied in again). */
  reset(): void {
    // The top 128K of the BIOS shows at E0000h-FFFFFh, in the RAM the BIOS shadows itself into.
    const top = this.bios.subarray(Math.max(0, this.bios.length - 0x20000));
    this.ram.set(top, 0x100000 - top.length);
    this.cpu.reset();
    this.pics.reset();
    this.pit.reset();
    this.dma.reset();
    this.kbc.reset();
    this.fdc.reset();
    this.ide[0].reset();
    this.ide[1].reset();
    this.vga.reset();
    for (const fn of this.pci.all) fn.config[4] = 0;
    // The keyboard controller's output port comes out of reset as CFh, with A20 enabled.
    this.a20Keyboard = true;
    this.a20Fast = false;
    this.updateA20();
    this.portB = 0;
    this.resetPending = false;
  }

  private updateA20(): void {
    this.cpu.setA20(this.a20Keyboard || this.a20Fast);
  }

  // --- Memory --------------------------------------------------------------------------

  directPage(address: number): number {
    if (address < this.ramBytes && (address < VGA_WINDOW_START || address >= VGA_WINDOW_END)) return address;
    const lfb = this.vga.lfbAddress;
    if (address >= lfb && address < lfb + VRAM_BYTES && this.vgaPci.memoryEnabled) return this.ramBytes + (address - lfb);
    return -1;
  }

  readMemory8(address: number): number {
    if (address >= VGA_WINDOW_START && address < VGA_WINDOW_END) return this.vga.readMemory(address);
    const rom = this.vgaPci.romAddress;
    if (rom && address >= rom && address < rom + VGA_ROM_SIZE) return this.vgaBios[address - rom] ?? 0xff;
    const biosStart = 0x100000000 - this.bios.length;
    if (address >= biosStart) return this.bios[address - biosStart];
    return 0xff;
  }

  writeMemory8(address: number, value: number): void {
    if (address >= VGA_WINDOW_START && address < VGA_WINDOW_END) this.vga.writeMemory(address, value);
  }

  // --- I/O -------------------------------------------------------------------------------

  private on(ports: number[] | number, read?: Reader, write?: Writer): void {
    for (const port of typeof ports === 'number' ? [ports] : ports) {
      if (read) this.readers8[port] = read;
      if (write) this.writers8[port] = write;
    }
  }

  private range(from: number, to: number): number[] {
    return Array.from({ length: to - from + 1 }, (_, i) => from + i);
  }

  private mapPorts(): void {
    const dmaPorts = [...this.range(0x00, 0x0f), ...this.range(0x80, 0x8f), ...this.range(0xc0, 0xdf)];
    this.on(dmaPorts, (p) => this.dma.read(p), (p, v) => this.dma.write(p, v));
    this.on([0x20, 0x21, 0xa0, 0xa1, 0x4d0, 0x4d1], (p) => this.pics.read(p), (p, v) => this.pics.write(p, v));
    this.on(this.range(0x40, 0x43), (p) => this.pit.read(p), (p, v) => this.pit.write(p, v));
    this.on(
      0x61,
      () => {
        const refresh = Math.floor(this.now() / 15000) & 1;
        return (this.portB & 0x0f) | (refresh << 4) | (this.pit.output(2) ? 0x20 : 0);
      },
      (_, v) => {
        this.portB = v;
        this.pit.setGate(2, (v & 1) !== 0);
      },
    );
    this.on(0x60, () => this.kbc.readData(), (_, v) => this.kbc.writeData(v));
    this.on(0x64, () => this.kbc.readStatus(), (_, v) => this.kbc.writeCommand(v));
    this.on([0x70, 0x71], (p) => this.rtc.read(p), (p, v) => this.rtc.write(p, v));
    this.on(
      0x92,
      () => (this.a20Fast ? 2 : 0),
      (_, v) => {
        this.a20Fast = (v & 2) !== 0;
        this.updateA20();
        if (v & 1) this.resetPending = true;
      },
    );
    this.on(0xcf9, () => 0, (_, v) => {
      if (v & 4) this.resetPending = true;
    });
    this.on([0xf0, 0xf1], () => 0xff, () => this.pics.setIrq(13, false));

    // IDE.
    for (const [index, base, control] of [
      [0, 0x1f0, 0x3f6],
      [1, 0x170, 0x376],
    ] as const) {
      const ch = this.ide[index];
      this.on(this.range(base + 1, base + 7), (p) => ch.readRegister(p - base), (p, v) => ch.writeRegister(p - base, v));
      this.on(base, () => ch.readData16() & 0xff, (_, v) => ch.writeData16(v));
      this.readers16[base] = () => ch.readData16();
      this.writers16[base] = (_, v) => ch.writeData16(v);
      this.readers32[base] = () => ch.readData16() | (ch.readData16() << 16);
      this.writers32[base] = (_, v) => {
        ch.writeData16(v & 0xffff);
        ch.writeData16(v >>> 16);
      };
      this.on(control, () => ch.readAltStatus(), (_, v) => ch.writeDeviceControl(v));
    }

    // Floppy.
    this.on([0x3f0, 0x3f1, 0x3f2, 0x3f3, 0x3f4, 0x3f5, 0x3f7], (p) => this.fdc.read(p), (p, v) => this.fdc.write(p, v));

    // VGA and VBE.
    this.on(this.range(0x3b0, 0x3df), (p) => this.vga.read(p), (p, v) => this.vga.write(p, v));
    for (const port of [0x1ce, 0x1cf, 0x1d0]) {
      const p = port === 0x1d0 ? 0x1cf : port;
      this.readers16[port] = () => this.vga.readVbe(p);
      this.writers16[port] = (_, v) => this.vga.writeVbe(p, v);
    }
    this.writers16[0x3c4] = (_, v) => {
      this.vga.write(0x3c4, v & 0xff);
      this.vga.write(0x3c5, v >> 8);
    };
    this.writers16[0x3ce] = (_, v) => {
      this.vga.write(0x3ce, v & 0xff);
      this.vga.write(0x3cf, v >> 8);
    };
    for (const port of [0x3b4, 0x3d4]) {
      this.writers16[port] = (_, v) => {
        this.vga.write(port, v & 0xff);
        this.vga.write(port + 1, v >> 8);
      };
    }

    // PCI configuration.
    this.readers32[0xcf8] = () => this.pci.readAddress();
    this.writers32[0xcf8] = (_, v) => this.pci.writeAddress(v);
    for (let i = 0; i < 4; i++) {
      this.readers8[0xcfc + i] = () => this.pci.readData(i, 1);
      this.writers8[0xcfc + i] = (_, v) => this.pci.writeData(i, v, 1);
    }
    this.readers16[0xcfc] = () => this.pci.readData(0, 2);
    this.readers16[0xcfe] = () => this.pci.readData(2, 2);
    this.writers16[0xcfc] = (_, v) => this.pci.writeData(0, v, 2);
    this.writers16[0xcfe] = (_, v) => this.pci.writeData(2, v, 2);
    this.readers32[0xcfc] = () => this.pci.readData(0, 4);
    this.writers32[0xcfc] = (_, v) => this.pci.writeData(0, v, 4);

    // SeaBIOS's debug console (QEMU's debugcon, which reads back E9h).
    this.on(0x402, () => 0xe9, (_, v) => {
      if (this.debugLog.length < 1 << 20) this.debugLog += String.fromCharCode(v);
    });
  }

  in8(port: number): number {
    return this.readers8[port]?.(port) ?? 0xff;
  }

  in16(port: number): number {
    const reader = this.readers16[port];
    if (reader) return reader(port) & 0xffff;
    return this.in8(port) | (this.in8((port + 1) & 0xffff) << 8);
  }

  in32(port: number): number {
    const reader = this.readers32[port];
    if (reader) return reader(port) | 0;
    return this.in16(port) | (this.in16((port + 2) & 0xffff) << 16);
  }

  out8(port: number, value: number): void {
    this.writers8[port]?.(port, value);
  }

  out16(port: number, value: number): void {
    const writer = this.writers16[port];
    if (writer) {
      writer(port, value);
      return;
    }
    this.out8(port, value & 0xff);
    this.out8((port + 1) & 0xffff, value >> 8);
  }

  out32(port: number, value: number): void {
    const writer = this.writers32[port];
    if (writer) {
      writer(port, value);
      return;
    }
    this.out16(port, value & 0xffff);
    this.out16((port + 2) & 0xffff, value >>> 16);
  }

  acknowledgeInterrupt(): number {
    return this.pics.acknowledge();
  }

  shutdown(): void {
    this.resetPending = true;
  }

  fpuError(): void {
    this.pics.setIrq(13, true);
  }

  // --- Running ---------------------------------------------------------------------------

  private nextEvent(): number {
    return Math.min(this.pit.nextIrq, this.rtc.nextEvent, this.ide[0].nextEvent, this.ide[1].nextEvent, this.fdc.nextEvent, this.kbc.nextEvent);
  }

  private updateDevices(now: number): void {
    this.pit.update(now);
    this.rtc.update(now);
    this.ide[0].update(now);
    this.ide[1].update(now);
    this.fdc.update(now);
    this.kbc.update();
  }

  /** Runs for `ns` of emulated time. */
  runFor(ns: number): void {
    const end = this.now() + ns;
    const cpu = this.cpu;
    while (this.now() < end) {
      const now = this.now();
      this.updateDevices(now);
      const next = Math.min(end, this.nextEvent());
      const cycles = Math.max(1, Math.min(MAX_SLICE, Math.ceil((next - now) / CYCLE_NS)));
      cpu.run(cycles);
      if (cpu.halted) {
        // Nothing to do until an interrupt: time moves on to the next event.
        const target = Math.ceil(next / CYCLE_NS);
        if (cpu.cycles < target) {
          this.idleCycles += target - cpu.cycles;
          cpu.cycles = target;
        }
      }
      if (this.resetPending) {
        this.reset();
        this.onReset();
      }
    }
  }
}
