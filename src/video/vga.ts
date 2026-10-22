import type { Clock } from '../chips/pit';

/** Video memory: 16 MB, enough for 1600 x 1200 in true colour with room to spare. */
export const VRAM_BYTES = 16 << 20;
/** The largest picture the card puts out. */
export const MAX_WIDTH = 1600;
export const MAX_HEIGHT = 1200;

// Bochs VBE ("DISPI") registers.
const VBE_ID = 0;
const VBE_XRES = 1;
const VBE_YRES = 2;
const VBE_BPP = 3;
const VBE_ENABLE = 4;
const VBE_BANK = 5;
const VBE_VIRT_WIDTH = 6;
const VBE_VIRT_HEIGHT = 7;
const VBE_X_OFFSET = 8;
const VBE_Y_OFFSET = 9;
const VBE_MEMORY_64K = 10;
const VBE_ENABLED = 0x01;
const VBE_GETCAPS = 0x02;
const VBE_8BIT_DAC = 0x20;
const VBE_NOCLEARMEM = 0x80;

/** Expands the low four bits into four bytes (a plane mask). */
const MASK16 = Int32Array.from({ length: 16 }, (_, i) => (i & 1 ? 0xff : 0) | (i & 2 ? 0xff00 : 0) | (i & 4 ? 0xff0000 : 0) | (i & 8 ? 0xff000000 : 0));

/** A frame refreshes this often; the retrace bits follow it. */
const FRAME_NS = 1e9 / 60;
const LINE_NS = 1e9 / 31469;

/**
 * A VGA with the Bochs/QEMU VBE extension, as SeaVGABIOS's "bochs-vga"
 * BIOS expects (PCI 1234:1111): the sequencer, graphics controller,
 * attribute controller, CRTC and DAC of a standard VGA with all its read
 * and write modes, and VBE modes up to 1600 x 1200 in 8, 15, 16, 24 and
 * 32 bits through a 64K bank at A0000h or the linear frame buffer.
 * Memory keeps the four planes of each address side by side, so chain-4,
 * VBE and the frame buffer all see it as plain bytes.
 */
export class Vga {
  readonly vram: Uint8Array;
  private readonly vram32: Int32Array;
  misc = 0;
  featureControl = 0;
  seqIndex = 0;
  readonly seq = new Uint8Array(8);
  gcIndex = 0;
  readonly gc = new Uint8Array(16);
  crtcIndex = 0;
  readonly crtc = new Uint8Array(0x40);
  attrIndex = 0;
  readonly attr = new Uint8Array(0x15);
  private attrFlipFlop = false;
  /** Bit 5 of the attribute index: palette access by the CPU blanks the screen when clear. */
  private attrPas = 0x20;
  dacWriteIndex = 0;
  dacReadIndex = 0;
  private dacSub = 0;
  dacState = 0;
  dacMask = 0xff;
  readonly dac = new Uint8Array(768);
  private latch = 0;
  vbeIndex = 0;
  readonly vbe = new Uint16Array(11);
  /** Where the PCI BAR puts the linear frame buffer. */
  lfbAddress = 0xe0000000;
  /** The finished picture, `width` x `height`. */
  readonly framebuffer = new Uint32Array(MAX_WIDTH * MAX_HEIGHT);
  width = 720;
  height = 400;
  private readonly palette = new Uint32Array(256);
  private frames = 0;

  /** `memory` holds the video memory at `offset` (shared with the CPU's RAM so the frame buffer can be accessed directly). */
  constructor(
    private readonly clock: Clock,
    memory: Uint8Array,
    offset: number,
  ) {
    this.vram = memory.subarray(offset, offset + VRAM_BYTES);
    this.vram32 = new Int32Array(memory.buffer, memory.byteOffset + offset, VRAM_BYTES >> 2);
    this.reset();
  }

  reset(): void {
    this.misc = 0;
    this.seq.fill(0);
    this.gc.fill(0);
    this.crtc.fill(0);
    this.attr.fill(0);
    this.vbe.fill(0);
    this.vbe[VBE_ID] = 0xb0c5;
    this.vbe[VBE_MEMORY_64K] = VRAM_BYTES >> 16;
    this.attrFlipFlop = false;
    this.dacMask = 0xff;
  }

  private get vbeEnabled(): boolean {
    return (this.vbe[VBE_ENABLE] & VBE_ENABLED) !== 0;
  }

  // --- The memory window at A0000h -----------------------------------------------------

  /** Reads `addr` in A0000h-BFFFFh. */
  readMemory(addr: number): number {
    addr -= 0xa0000;
    if (this.vbeEnabled && this.vbe[VBE_BPP] > 4) {
      if (addr >= 0x10000) return 0xff;
      return this.vram[(this.vbe[VBE_BANK] << 16) + addr];
    }
    const window = this.windowOffset(addr);
    if (window < 0) return 0xff;
    addr = window;
    if (this.seq[4] & 0x08) return this.vram[addr];
    if (this.gc[5] & 0x10) {
      const plane = (this.gc[4] & 2) | (addr & 1);
      return this.vram[((addr & ~1) << 1) | plane];
    }
    this.latch = this.vram32[addr];
    if (!(this.gc[5] & 0x08)) return (this.latch >>> (this.gc[4] & 3) * 8) & 0xff;
    let r = (this.latch ^ MASK16[this.gc[2] & 0xf]) & MASK16[this.gc[7] & 0xf];
    r |= r >>> 16;
    r |= r >>> 8;
    return ~r & 0xff;
  }

  writeMemory(addr: number, value: number): void {
    addr -= 0xa0000;
    if (this.vbeEnabled && this.vbe[VBE_BPP] > 4) {
      if (addr < 0x10000) this.vram[(this.vbe[VBE_BANK] << 16) + addr] = value;
      return;
    }
    const window = this.windowOffset(addr);
    if (window < 0) return;
    addr = window;
    if (this.seq[4] & 0x08) {
      if (this.seq[2] & (1 << (addr & 3))) this.vram[addr] = value;
      return;
    }
    if (this.gc[5] & 0x10) {
      const plane = (this.gc[4] & 2) | (addr & 1);
      if (this.seq[2] & (1 << plane)) this.vram[((addr & ~1) << 1) | plane] = value;
      return;
    }
    const gc = this.gc;
    let v: number;
    let bitMask = gc[8];
    switch (gc[5] & 3) {
      case 0: {
        const rotate = gc[3] & 7;
        v = ((value >> rotate) | (value << (8 - rotate))) & 0xff;
        v *= 0x01010101;
        const setMask = MASK16[gc[1] & 0xf];
        v = (v & ~setMask) | (MASK16[gc[0] & 0xf] & setMask);
        break;
      }
      case 1:
        v = this.latch;
        bitMask = -1;
        break;
      case 2:
        v = MASK16[value & 0xf];
        break;
      default: {
        const rotate = gc[3] & 7;
        const rotated = ((value >> rotate) | (value << (8 - rotate))) & 0xff;
        bitMask &= rotated;
        v = MASK16[gc[0] & 0xf];
      }
    }
    if ((gc[5] & 3) !== 1) {
      switch ((gc[3] >> 3) & 3) {
        case 1:
          v &= this.latch;
          break;
        case 2:
          v |= this.latch;
          break;
        case 3:
          v ^= this.latch;
          break;
      }
      const bits = (bitMask & 0xff) * 0x01010101;
      v = (v & bits) | (this.latch & ~bits);
    }
    const writeMask = MASK16[this.seq[2] & 0xf];
    this.vram32[addr] = (this.vram32[addr] & ~writeMask) | (v & writeMask);
  }

  /** The plane offset an address in the window reaches, by the graphics controller's memory map; -1 outside it. */
  private windowOffset(addr: number): number {
    switch ((this.gc[6] >> 2) & 3) {
      case 0:
        return addr;
      case 1:
        return addr < 0x10000 ? addr : -1;
      case 2:
        return addr >= 0x10000 && addr < 0x18000 ? addr - 0x10000 : -1;
      default:
        return addr >= 0x18000 ? addr - 0x18000 : -1;
    }
  }

  // --- I/O ports -------------------------------------------------------------------------

  /** CRTC ports are at 3Dxh in colour modes and 3Bxh in monochrome ones. */
  private crtcPortOk(port: number): boolean {
    const mono = !(this.misc & 1);
    return (port & 0xfff0) === (mono ? 0x3b0 : 0x3d0);
  }

  read(port: number): number {
    switch (port) {
      case 0x3c0:
        return this.attrIndex | this.attrPas;
      case 0x3c1:
        return this.attr[this.attrIndex] ?? 0;
      case 0x3c2:
        return 0x10;
      case 0x3c4:
        return this.seqIndex;
      case 0x3c5:
        return this.seq[this.seqIndex & 7];
      case 0x3c6:
        return this.dacMask;
      case 0x3c7:
        return this.dacState;
      case 0x3c8:
        return this.dacWriteIndex;
      case 0x3c9: {
        const value = this.dac[this.dacReadIndex * 3 + this.dacSub];
        if (++this.dacSub === 3) {
          this.dacSub = 0;
          this.dacReadIndex = (this.dacReadIndex + 1) & 0xff;
        }
        return value;
      }
      case 0x3ca:
        return this.featureControl;
      case 0x3cc:
        return this.misc;
      case 0x3ce:
        return this.gcIndex;
      case 0x3cf:
        return this.gc[this.gcIndex & 0xf];
      case 0x3b4:
      case 0x3d4:
        return this.crtcPortOk(port) ? this.crtcIndex : 0xff;
      case 0x3b5:
      case 0x3d5:
        return this.crtcPortOk(port) ? this.crtc[this.crtcIndex & 0x3f] : 0xff;
      case 0x3ba:
      case 0x3da: {
        if (!this.crtcPortOk(port)) return 0xff;
        this.attrFlipFlop = false;
        return this.retraceBits();
      }
      default:
        return 0xff;
    }
  }

  private retraceBits(): number {
    const now = this.clock.now();
    const inFrame = now % FRAME_NS;
    const vertical = inFrame > FRAME_NS * 0.94;
    const horizontal = now % LINE_NS > LINE_NS * 0.8;
    return (vertical ? 0x08 : 0) | (vertical || horizontal ? 0x01 : 0);
  }

  write(port: number, value: number): void {
    switch (port) {
      case 0x3c0:
        if (!this.attrFlipFlop) {
          this.attrIndex = value & 0x1f;
          this.attrPas = value & 0x20;
        } else if (this.attrIndex < 0x15) {
          this.attr[this.attrIndex] = value;
        }
        this.attrFlipFlop = !this.attrFlipFlop;
        return;
      case 0x3c2:
        this.misc = value;
        return;
      case 0x3c4:
        this.seqIndex = value & 7;
        return;
      case 0x3c5:
        this.seq[this.seqIndex] = value;
        return;
      case 0x3c6:
        this.dacMask = value;
        return;
      case 0x3c7:
        this.dacReadIndex = value;
        this.dacSub = 0;
        this.dacState = 0;
        return;
      case 0x3c8:
        this.dacWriteIndex = value;
        this.dacSub = 0;
        this.dacState = 3;
        return;
      case 0x3c9:
        this.dac[this.dacWriteIndex * 3 + this.dacSub] = value;
        if (++this.dacSub === 3) {
          this.dacSub = 0;
          this.dacWriteIndex = (this.dacWriteIndex + 1) & 0xff;
        }
        return;
      case 0x3ce:
        this.gcIndex = value & 0xf;
        return;
      case 0x3cf:
        this.gc[this.gcIndex] = value;
        return;
      case 0x3b4:
      case 0x3d4:
        if (this.crtcPortOk(port)) this.crtcIndex = value & 0x3f;
        return;
      case 0x3b5:
      case 0x3d5: {
        if (!this.crtcPortOk(port)) return;
        const i = this.crtcIndex;
        // Registers 0-7 are write protected by bit 7 of register 11h (except the line compare bit of 7).
        if (this.crtc[0x11] & 0x80 && i <= 7) {
          if (i === 7) this.crtc[7] = (this.crtc[7] & ~0x10) | (value & 0x10);
          return;
        }
        this.crtc[i] = value;
        return;
      }
      case 0x3ba:
      case 0x3da:
        if (this.crtcPortOk(port)) this.featureControl = value;
        return;
    }
  }

  readVbe(port: number): number {
    if (port === 0x1ce) return this.vbeIndex;
    const i = this.vbeIndex;
    if (i > VBE_MEMORY_64K) return 0;
    if (this.vbe[VBE_ENABLE] & VBE_GETCAPS) {
      if (i === VBE_XRES) return MAX_WIDTH;
      if (i === VBE_YRES) return MAX_HEIGHT;
      if (i === VBE_BPP) return 32;
    }
    return this.vbe[i];
  }

  writeVbe(port: number, value: number): void {
    if (port === 0x1ce) {
      this.vbeIndex = value;
      return;
    }
    const i = this.vbeIndex;
    switch (i) {
      case VBE_ID:
        if (value >= 0xb0c0 && value <= 0xb0c5) this.vbe[VBE_ID] = value;
        return;
      case VBE_XRES:
        this.vbe[i] = Math.min(value, MAX_WIDTH) & ~7;
        return;
      case VBE_YRES:
        this.vbe[i] = Math.min(value, MAX_HEIGHT);
        return;
      case VBE_BPP:
        this.vbe[i] = [4, 8, 15, 16, 24, 32].includes(value) ? value : value === 0 ? 8 : this.vbe[i];
        return;
      case VBE_BANK:
        this.vbe[i] = value & 0xff;
        return;
      case VBE_ENABLE: {
        const wasEnabled = this.vbeEnabled;
        this.vbe[i] = value;
        if (value & VBE_ENABLED && !wasEnabled) {
          this.vbe[VBE_VIRT_WIDTH] = this.vbe[VBE_XRES];
          this.vbe[VBE_VIRT_HEIGHT] = this.vbe[VBE_YRES];
          this.vbe[VBE_X_OFFSET] = this.vbe[VBE_Y_OFFSET] = 0;
          if (!(value & VBE_NOCLEARMEM)) this.vram.fill(0, 0, Math.min(VRAM_BYTES, this.vbe[VBE_XRES] * this.vbe[VBE_YRES] * 4));
          // VBE modes use the graphics controller's packed-pixel setting, as QEMU's stdvga sets it.
          this.gc[6] = (this.gc[6] & ~0x0c) | 0x05;
          this.seq[4] |= 0x08;
        }
        return;
      }
      case VBE_VIRT_WIDTH: {
        this.vbe[i] = value;
        const bytes = Math.max(1, (this.bytesPerPixel || 1) * value);
        this.vbe[VBE_VIRT_HEIGHT] = Math.floor(VRAM_BYTES / bytes);
        return;
      }
      case VBE_X_OFFSET:
      case VBE_Y_OFFSET:
        this.vbe[i] = value;
        return;
    }
  }

  private get bytesPerPixel(): number {
    return (this.vbe[VBE_BPP] + 7) >> 3;
  }

  // --- The picture -----------------------------------------------------------------------

  private updatePalette(): void {
    const wide = (this.vbe[VBE_ENABLE] & VBE_8BIT_DAC) !== 0;
    const dac = this.dac;
    for (let i = 0; i < 256; i++) {
      let r = dac[i * 3];
      let g = dac[i * 3 + 1];
      let b = dac[i * 3 + 2];
      if (!wide) {
        r = ((r & 0x3f) << 2) | ((r & 0x3f) >> 4);
        g = ((g & 0x3f) << 2) | ((g & 0x3f) >> 4);
        b = ((b & 0x3f) << 2) | ((b & 0x3f) >> 4);
      }
      this.palette[i] = (0xff000000 | (b << 16) | (g << 8) | r) >>> 0;
    }
  }

  /** The DAC entry an attribute controller palette index (0-15) goes to. */
  private attrColor(index: number): number {
    const a = this.attr;
    let v = a[index & 0xf];
    if (a[0x10] & 0x80) v = (v & 0x0f) | ((a[0x14] & 0x0f) << 4);
    else v = (v & 0x3f) | ((a[0x14] & 0x0c) << 4);
    return v & this.dacMask;
  }

  /** Draws the current picture into `framebuffer` (setting `width` and `height`). */
  render(): void {
    this.frames++;
    this.updatePalette();
    if (this.vbeEnabled && this.vbe[VBE_BPP] > 4) {
      this.renderVbe();
      return;
    }
    if (!this.attrPas || this.seq[1] & 0x20) {
      // Screen off (attribute palette being written, or the sequencer's screen-off bit).
      this.blank();
      return;
    }
    if (this.gc[6] & 1) this.renderGraphics();
    else this.renderText();
  }

  private blank(): void {
    const w = this.width;
    const h = this.height;
    this.framebuffer.fill(0xff000000, 0, w * h);
  }

  private get verticalDisplay(): number {
    const c = this.crtc;
    return (c[0x12] | ((c[7] & 0x02) << 7) | ((c[7] & 0x40) << 3)) + 1;
  }

  private get startAddress(): number {
    return (this.crtc[0x0c] << 8) | this.crtc[0x0d];
  }

  private get lineCompare(): number {
    const c = this.crtc;
    return c[0x18] | ((c[7] & 0x10) << 4) | ((c[9] & 0x40) << 3);
  }

  private setSize(width: number, height: number): void {
    this.width = Math.max(8, Math.min(width, MAX_WIDTH));
    this.height = Math.max(8, Math.min(height, MAX_HEIGHT));
  }

  private renderText(): void {
    const c = this.crtc;
    const seq = this.seq;
    const charWidth = seq[1] & 1 ? 8 : 9;
    const doubleWidth = (seq[1] & 0x08) !== 0;
    const columns = c[1] + 1;
    const charHeight = (c[9] & 0x1f) + 1;
    const doubleScan = (c[9] & 0x80) !== 0;
    const lines = this.verticalDisplay;
    const rows = Math.max(1, Math.floor(lines / (charHeight * (doubleScan ? 2 : 1))));
    const pixelWidth = charWidth * (doubleWidth ? 2 : 1);
    this.setSize(columns * pixelWidth, rows * charHeight * (doubleScan ? 2 : 1));
    const width = this.width;
    const fb = this.framebuffer;
    const vram = this.vram;
    const pal = this.palette;
    const stride = c[0x13] * 2;
    let address = this.startAddress;
    const cursor = (c[0x0e] << 8) | c[0x0f];
    const cursorStart = c[0x0a] & 0x1f;
    const cursorEnd = c[0x0b] & 0x1f;
    const cursorOn = !(c[0x0a] & 0x20) && (this.frames >> 4) & 1;
    const blinkEnabled = (this.attr[0x10] & 0x08) !== 0;
    const blinkOn = (this.frames >> 5) & 1;
    const lineGraphics = (this.attr[0x10] & 0x04) !== 0;
    const map = seq[3];
    const fontA = ((((map >> 5) & 1) | ((map >> 1) & 6)) * 8192) << 2;
    const fontB = ((((map >> 4) & 1) | ((map << 1) & 6)) * 8192) << 2;
    const colors = new Uint32Array(16);
    for (let i = 0; i < 16; i++) colors[i] = pal[this.attrColor(i)];

    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < columns; col++) {
        const cell = ((address + col) & 0xffff) << 2;
        const ch = vram[cell];
        const at = vram[cell + 1];
        let fg = at & 0x0f;
        let bg = at >> 4;
        if (blinkEnabled) {
          bg &= 7;
          if (at & 0x80 && !blinkOn) fg = bg;
        }
        const glyph = (at & 0x08 ? fontA : fontB) + ch * 128 + 2;
        const fgc = colors[fg];
        const bgc = colors[bg];
        const isCursor = cursorOn && address + col === cursor;
        for (let y = 0; y < charHeight; y++) {
          let bits = vram[glyph + y * 4];
          if (isCursor && y >= cursorStart && y <= cursorEnd) bits = 0xff;
          const ninth = charWidth === 9 && lineGraphics && ch >= 0xc0 && ch <= 0xdf ? bits & 1 : isCursor && y >= cursorStart && y <= cursorEnd ? 1 : 0;
          const scanCount = doubleScan ? 2 : 1;
          for (let s = 0; s < scanCount; s++) {
            let p = ((row * charHeight + y) * scanCount + s) * width + col * pixelWidth;
            for (let x = 0; x < charWidth; x++) {
              const on = x < 8 ? (bits >> (7 - x)) & 1 : ninth;
              const color = on ? fgc : bgc;
              fb[p++] = color;
              if (doubleWidth) fb[p++] = color;
            }
          }
        }
      }
      address += stride;
    }
  }

  private renderGraphics(): void {
    const c = this.crtc;
    const shiftControl = (this.gc[5] >> 5) & 3;
    // With the dot clock halved (the 320-pixel planar and CGA modes) each pixel is shown twice across.
    const dotsHalved = (this.seq[1] & 0x08) !== 0;
    const width = (c[1] + 1) * 8 * (dotsHalved ? 2 : 1);
    const lines = this.verticalDisplay;
    const doubleScan = c[9] >> 7;
    const multiScan = shiftControl !== 1 ? (((c[9] & 0x1f) + 1) << doubleScan) - 1 : doubleScan;
    this.setSize(width, lines);
    const fb = this.framebuffer;
    const vram = this.vram;
    const pal = this.palette;
    const lineOffset = c[0x13] << 3;
    const planeMask = MASK16[this.attr[0x12] & 0xf];
    const colors = new Uint32Array(16);
    for (let i = 0; i < 16; i++) colors[i] = pal[this.attrColor(i)];
    let rowAddress = this.startAddress << 2;
    let multiRun = multiScan;
    let y1 = 0;
    const compare = this.lineCompare;
    const cgaMode = !(c[0x17] & 1);
    const cgaShift = 14 + ((c[0x17] >> 6) & 1);
    const hercMode = !(c[0x17] & 2);

    for (let y = 0; y < lines; y++) {
      let address = rowAddress;
      if (cgaMode) address = (address & ~(1 << cgaShift)) | ((y1 & 1) << cgaShift);
      if (hercMode) address = (address & ~0x8000) | ((y1 & 2) << 14);
      let p = y * width;
      const end = p + width;
      if (shiftControl === 0) {
        // 16 colours from four planes, eight pixels a word.
        while (p < end) {
          const planes = this.vram32[(address >> 2) & (VRAM_BYTES / 4 - 1)] & planeMask;
          for (let bit = 7; bit >= 0 && p < end; bit--) {
            const v = ((planes >> bit) & 1) | (((planes >> (8 + bit)) & 1) << 1) | (((planes >> (16 + bit)) & 1) << 2) | (((planes >> (24 + bit)) & 1) << 3);
            fb[p++] = colors[v];
            if (dotsHalved) fb[p++] = colors[v];
          }
          address += 4;
        }
      } else if (shiftControl === 1) {
        // CGA's 4 colours: two bits a pixel, interleaved over planes 0 and 1.
        while (p < end) {
          const word = this.vram32[(address >> 2) & (VRAM_BYTES / 4 - 1)];
          const bytes = [word & 0xff, (word >> 8) & 0xff];
          for (const b of bytes) {
            for (let shift = 6; shift >= 0 && p < end; shift -= 2) {
              const v = (b >> shift) & 3;
              fb[p++] = colors[v];
              if (dotsHalved) fb[p++] = colors[v];
            }
          }
          address += 4;
        }
      } else {
        // 256 colours, a byte a pixel (shown twice across, as mode 13h's 320 pixels fill 640 dots).
        while (p < end) {
          const color = pal[vram[address & (VRAM_BYTES - 1)] & this.dacMask];
          fb[p++] = color;
          if (p < end) fb[p++] = color;
          address++;
        }
      }
      if (!multiRun) {
        const mask = (c[0x17] & 3) ^ 3;
        if ((y1 & mask) === mask) rowAddress += lineOffset;
        y1++;
        multiRun = multiScan;
      } else {
        multiRun--;
      }
      if (y === compare) rowAddress = 0;
    }
  }

  private renderVbe(): void {
    const v = this.vbe;
    const width = v[VBE_XRES] || 640;
    const height = v[VBE_YRES] || 480;
    this.setSize(width, height);
    const bpp = v[VBE_BPP];
    const bytes = this.bytesPerPixel;
    const stride = (v[VBE_VIRT_WIDTH] || width) * bytes;
    const fb = this.framebuffer;
    const vram = this.vram;
    const pal = this.palette;
    let row = v[VBE_Y_OFFSET] * stride + v[VBE_X_OFFSET] * bytes;
    for (let y = 0; y < this.height; y++) {
      let p = y * this.width;
      let a = row;
      if (a + this.width * bytes > VRAM_BYTES) break;
      switch (bpp) {
        case 8:
          for (let x = 0; x < this.width; x++) fb[p++] = pal[vram[a++]];
          break;
        case 15:
          for (let x = 0; x < this.width; x++, a += 2) {
            const c = vram[a] | (vram[a + 1] << 8);
            const r = (c >> 10) & 0x1f;
            const g = (c >> 5) & 0x1f;
            const b = c & 0x1f;
            fb[p++] = (0xff000000 | (((b << 3) | (b >> 2)) << 16) | (((g << 3) | (g >> 2)) << 8) | ((r << 3) | (r >> 2))) >>> 0;
          }
          break;
        case 16:
          for (let x = 0; x < this.width; x++, a += 2) {
            const c = vram[a] | (vram[a + 1] << 8);
            const r = c >> 11;
            const g = (c >> 5) & 0x3f;
            const b = c & 0x1f;
            fb[p++] = (0xff000000 | (((b << 3) | (b >> 2)) << 16) | (((g << 2) | (g >> 4)) << 8) | ((r << 3) | (r >> 2))) >>> 0;
          }
          break;
        case 24:
          for (let x = 0; x < this.width; x++, a += 3) fb[p++] = (0xff000000 | (vram[a] << 16) | (vram[a + 1] << 8) | vram[a + 2]) >>> 0;
          break;
        default:
          for (let x = 0; x < this.width; x++, a += 4) fb[p++] = (0xff000000 | (vram[a] << 16) | (vram[a + 1] << 8) | vram[a + 2]) >>> 0;
      }
      row += stride;
    }
  }

  /** The text on a text-mode screen, a line per row (for tests and the debugger). */
  screenText(): string {
    if (this.gc[6] & 1 || this.vbeEnabled) return '';
    const columns = this.crtc[1] + 1;
    const charHeight = (this.crtc[9] & 0x1f) + 1;
    const rows = Math.max(1, Math.floor(this.verticalDisplay / charHeight));
    const lines: string[] = [];
    let address = this.startAddress;
    for (let row = 0; row < rows; row++) {
      let line = '';
      for (let col = 0; col < columns; col++) {
        const ch = this.vram[((address + col) & 0xffff) << 2];
        line += ch >= 0x20 && ch < 0x7f ? String.fromCharCode(ch) : ' ';
      }
      lines.push(line.trimEnd());
      address += this.crtc[0x13] * 2;
    }
    return lines.join('\n');
  }
}
