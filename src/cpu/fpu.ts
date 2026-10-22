import type { Cpu } from './cpu';

// Status word bits.
const IE = 0x01;
const ZE = 0x04;
const OE = 0x08;
const PE = 0x20;
const SF = 0x40;
const ES = 0x80;
const C0 = 0x100;
const C1 = 0x200;
const C2 = 0x400;
const C3 = 0x4000;
const BUSY = 0x8000;
const CONDITION = C0 | C1 | C2 | C3;

const scratch = new DataView(new ArrayBuffer(8));

const LOG2_10 = Math.log2(10);
const LOG2_E = Math.LOG2E;
const LOG10_2 = Math.log10(2);
const LN_2 = Math.LN2;

/** The x87 value for an invalid operation when it is masked: a negative quiet NaN. */
const INDEFINITE = NaN;

/**
 * The x87 floating-point unit: eight registers kept as doubles (so 53 bits
 * of precision rather than 64), the control, status and tag words, and the
 * whole instruction set including the transcendental functions and the
 * environment and state saves. Exceptions set their status bits; unmasked
 * ones are reported to the CPU when the next FPU instruction or FWAIT runs.
 */
export class Fpu {
  /** The physical registers; ST(i) is st[(top + i) & 7]. */
  readonly st = new Float64Array(8);
  /** Which physical registers are empty (one bit each). */
  empty = 0xff;
  cw = 0x37f;
  /** The status word without TOP. */
  sw = 0;
  top = 0;

  constructor(private readonly cpu: Cpu) {}

  reset(): void {
    this.init();
    this.cw = 0x40;
  }

  private init(): void {
    this.cw = 0x37f;
    this.sw = 0;
    this.top = 0;
    this.empty = 0xff;
    this.st.fill(0);
  }

  get status(): number {
    return (this.sw & ~0x3800) | (this.top << 11);
  }

  /** The tag word: two bits a register (valid, zero, special or empty). */
  get tagWord(): number {
    let tags = 0;
    for (let i = 0; i < 8; i++) {
      let tag: number;
      if (this.empty & (1 << i)) tag = 3;
      else {
        const v = this.st[i];
        if (v === 0) tag = 1;
        else if (!Number.isFinite(v) || Math.abs(v) < 2.2250738585072014e-308) tag = 2;
        else tag = 0;
      }
      tags |= tag << (i * 2);
    }
    return tags;
  }

  private setTagWord(tags: number): void {
    this.empty = 0;
    for (let i = 0; i < 8; i++) if (((tags >> (i * 2)) & 3) === 3) this.empty |= 1 << i;
  }

  // --- The stack -------------------------------------------------------------------------

  private exception(flags: number): void {
    this.sw |= flags;
    if (flags & ~this.cw & 0x3f) this.sw |= ES | BUSY;
  }

  private isEmpty(i: number): boolean {
    return (this.empty & (1 << ((this.top + i) & 7))) !== 0;
  }

  /** ST(i); reading an empty register is a stack underflow, giving NaN. */
  private get(i: number): number {
    const phys = (this.top + i) & 7;
    if (this.empty & (1 << phys)) {
      this.exception(IE | SF);
      this.sw &= ~C1;
      return INDEFINITE;
    }
    return this.st[phys];
  }

  private set(i: number, v: number): void {
    const phys = (this.top + i) & 7;
    this.st[phys] = v;
    this.empty &= ~(1 << phys);
  }

  private push(v: number): void {
    const top = (this.top - 1) & 7;
    if (!(this.empty & (1 << top))) {
      this.exception(IE | SF | C1);
      v = INDEFINITE;
    } else {
      this.sw &= ~C1;
    }
    this.top = top;
    this.st[top] = v;
    this.empty &= ~(1 << top);
  }

  private pop(): void {
    this.empty |= 1 << this.top;
    this.top = (this.top + 1) & 7;
  }

  // --- Rounding and conversions ------------------------------------------------------

  /** Rounds to an integer the way the control word's rounding field says. */
  private round(v: number): number {
    switch ((this.cw >> 10) & 3) {
      case 0: {
        const f = Math.floor(v);
        const d = v - f;
        if (d > 0.5) return f + 1;
        if (d < 0.5) return f;
        return f % 2 === 0 ? f : f + 1;
      }
      case 1:
        return Math.floor(v);
      case 2:
        return Math.ceil(v);
      default:
        return Math.trunc(v);
    }
  }

  /** Rounds for an integer store; out of range (or NaN) is invalid, giving the "integer indefinite". */
  private toInteger(v: number, bits: number): number | null {
    const r = this.round(v);
    const limit = 2 ** (bits - 1);
    if (!(r >= -limit && r < limit)) {
      this.exception(IE);
      return null;
    }
    if (r !== v) this.exception(PE);
    return r;
  }

  private static fromFloat32(bits: number): number {
    scratch.setInt32(0, bits, true);
    return scratch.getFloat32(0, true);
  }

  private static toFloat32(v: number): number {
    scratch.setFloat32(0, v, true);
    return scratch.getInt32(0, true);
  }

  private static fromFloat64(lo: number, hi: number): number {
    scratch.setInt32(0, lo, true);
    scratch.setInt32(4, hi, true);
    return scratch.getFloat64(0, true);
  }

  private static toFloat64(v: number): [number, number] {
    scratch.setFloat64(0, v, true);
    return [scratch.getInt32(0, true), scratch.getInt32(4, true)];
  }

  /** An 80-bit extended real (64-bit mantissa with its integer bit, 15-bit exponent, sign) as a double. */
  static fromExtended(lo: number, hi: number, signExp: number): number {
    const sign = signExp & 0x8000 ? -1 : 1;
    const exp = signExp & 0x7fff;
    const mantissa = (hi >>> 0) * 0x100000000 + (lo >>> 0);
    if (exp === 0x7fff) return (hi & 0x7fffffff) === 0 && lo === 0 ? sign * Infinity : NaN;
    if (mantissa === 0) return sign * 0;
    const e = (exp === 0 ? 1 : exp) - 16383 - 63;
    // In two steps, so a large mantissa with a small exponent doesn't underflow halfway.
    const half = Math.trunc(e / 2);
    return sign * mantissa * 2 ** half * 2 ** (e - half);
  }

  /** A double as an 80-bit extended real: [mantissa low, mantissa high, sign and exponent]. */
  static toExtended(v: number): [number, number, number] {
    scratch.setFloat64(0, v, true);
    const lo = scratch.getUint32(0, true);
    const hi = scratch.getUint32(4, true);
    const sign = hi >>> 31 ? 0x8000 : 0;
    const exp = (hi >>> 20) & 0x7ff;
    const frac = hi & 0xfffff;
    if (exp === 0x7ff) {
      if (frac === 0 && lo === 0) return [0, 0x80000000 | 0, sign | 0x7fff];
      return [(lo << 11) | 0, (0xc0000000 | (frac << 11) | (lo >>> 21)) | 0, sign | 0x7fff];
    }
    if (exp === 0) {
      if (frac === 0 && lo === 0) return [0, 0, sign];
      // A double denormal is a normal extended number.
      const m = Math.abs(v);
      const e = Math.floor(Math.log2(m));
      const mant = m / 2 ** e;
      const mHi = Math.floor(mant * 2 ** 31);
      const mLo = Math.floor((mant * 2 ** 31 - mHi) * 2 ** 32);
      return [mLo | 0, mHi | 0, sign | (e + 16383)];
    }
    return [(lo << 11) | 0, (0x80000000 | (frac << 11) | (lo >>> 21)) | 0, sign | (exp - 1023 + 16383)];
  }

  // --- Memory operands ---------------------------------------------------------------

  private readExtended(at: number): number {
    const c = this.cpu;
    return Fpu.fromExtended(c.fpuRead32(at), c.fpuRead32(at + 4), c.fpuRead16(at + 8));
  }

  private writeExtended(at: number, v: number): void {
    const [lo, hi, se] = Fpu.toExtended(v);
    const c = this.cpu;
    c.fpuWrite32(lo, at);
    c.fpuWrite32(hi, at + 4);
    c.fpuWrite16(se, at + 8);
  }

  private readInt64(): number {
    const lo = this.cpu.fpuRead32(0) >>> 0;
    const hi = this.cpu.fpuRead32(4);
    return hi * 0x100000000 + lo;
  }

  private writeInt64(v: number | null): void {
    let lo = 0;
    let hi = 0x80000000 | 0;
    if (v !== null) {
      const n = BigInt.asUintN(64, BigInt(v));
      lo = Number(n & 0xffffffffn) | 0;
      hi = Number(n >> 32n) | 0;
    }
    this.cpu.fpuWrite32(lo, 0);
    this.cpu.fpuWrite32(hi, 4);
  }

  /** The memory operand of the arithmetic forms: 0 m32 real, 1 m32 integer, 2 m64 real, 3 m16 integer. */
  private readOperand(kind: number): number {
    const c = this.cpu;
    switch (kind) {
      case 0:
        return Fpu.fromFloat32(c.fpuRead32());
      case 1:
        return c.fpuRead32();
      case 2:
        return Fpu.fromFloat64(c.fpuRead32(0), c.fpuRead32(4));
      default:
        return (c.fpuRead16() << 16) >> 16;
    }
  }

  private readBcd(): number {
    let v = 0;
    for (let i = 8; i >= 0; i--) {
      const b = this.cpu.fpuRead8(i);
      v = v * 100 + (b >> 4) * 10 + (b & 0xf);
    }
    return this.cpu.fpuRead8(9) & 0x80 ? -v : v;
  }

  private writeBcd(v: number): void {
    const r = this.round(v);
    const c = this.cpu;
    c.fpuCheckWrite(10);
    if (!(Math.abs(r) < 1e18)) {
      this.exception(IE);
      for (let i = 0; i < 7; i++) c.fpuWrite8(0, i);
      c.fpuWrite8(0xc0, 7);
      c.fpuWrite8(0xff, 8);
      c.fpuWrite8(0xff, 9);
      return;
    }
    let n = BigInt(Math.abs(r));
    for (let i = 0; i < 9; i++) {
      const low = Number(n % 10n);
      n /= 10n;
      const high = Number(n % 10n);
      n /= 10n;
      c.fpuWrite8((high << 4) | low, i);
    }
    c.fpuWrite8(r < 0 || Object.is(r, -0) ? 0x80 : 0, 9);
  }

  // --- Arithmetic --------------------------------------------------------------------

  /** The arithmetic group: 0 add, 1 mul, 4 a-b, 5 b-a, 6 a/b, 7 b/a (2 and 3 compare). */
  private arith(kind: number, a: number, b: number): number {
    switch (kind) {
      case 0:
        return a + b;
      case 1:
        return a * b;
      case 4:
        return a - b;
      case 5:
        return b - a;
      case 6:
        if (b === 0 && a === a && a !== 0 && Number.isFinite(a)) this.exception(ZE);
        else if (b === 0 && a === 0) this.exception(IE);
        return a / b;
      default:
        if (a === 0 && b === b && b !== 0 && Number.isFinite(b)) this.exception(ZE);
        else if (a === 0 && b === 0) this.exception(IE);
        return b / a;
    }
  }

  private compare(a: number, b: number, quiet = false): void {
    let cc: number;
    if (a !== a || b !== b) {
      cc = C0 | C2 | C3;
      if (!quiet) this.exception(IE);
    } else if (a > b) cc = 0;
    else if (a < b) cc = C0;
    else cc = C3;
    this.sw = (this.sw & ~CONDITION) | cc;
  }

  private examine(): void {
    let cc: number;
    const v = this.st[this.top];
    const negative = v < 0 || Object.is(v, -0) ? C1 : 0;
    if (this.isEmpty(0)) cc = C0 | C3;
    else if (v !== v) cc = C0;
    else if (!Number.isFinite(v)) cc = C0 | C2;
    else if (v === 0) cc = C3;
    else if (Math.abs(v) < 2.2250738585072014e-308) cc = C2 | C3;
    else cc = C2;
    this.sw = (this.sw & ~CONDITION) | cc | negative;
  }

  /** FPREM and FPREM1: the remainder of ST(0) / ST(1), and the low quotient bits in C0, C3, C1. */
  private remainder(ieee: boolean): void {
    const a = this.get(0);
    const b = this.get(1);
    if (b === 0 || !Number.isFinite(a) || b !== b) {
      this.exception(IE);
      this.set(0, NaN);
      return;
    }
    const q = ieee ? Math.round(a / b) : Math.trunc(a / b);
    const r = ieee ? a - q * b : a % b;
    const bits = Math.abs(q) % 8;
    this.set(0, r);
    let cc = 0;
    if (bits & 4) cc |= C0;
    if (bits & 2) cc |= C3;
    if (bits & 1) cc |= C1;
    this.sw = (this.sw & ~CONDITION) | cc;
  }

  // --- Decoding --------------------------------------------------------------------------

  /** FWAIT: reports a pending unmasked exception. */
  wait(): void {
    if (this.sw & ES) this.cpu.fpuException();
  }

  /** Runs an ESC instruction: `op` is D8-DF, `modrm` its ModR/M byte (the CPU has decoded the address). */
  execute(op: number, modrm: number): void {
    const reg = (modrm >> 3) & 7;
    const isControl = (op === 0xd9 && modrm < 0xc0 && reg >= 4) || (op === 0xdb && (modrm === 0xe2 || modrm === 0xe3)) || (op === 0xdd && modrm < 0xc0 && reg >= 4) || (op === 0xdf && modrm === 0xe0);
    if (!isControl && this.sw & ES) this.cpu.fpuException();
    if (modrm < 0xc0) this.memoryForm(op, reg);
    else this.registerForm(op, reg, modrm & 7);
  }

  private memoryForm(op: number, reg: number): void {
    const c = this.cpu;
    switch (op) {
      case 0xd8:
      case 0xda:
      case 0xdc:
      case 0xde: {
        const v = this.readOperand((op - 0xd8) >> 1);
        if (reg === 2 || reg === 3) {
          this.compare(this.get(0), v);
          if (reg === 3) this.pop();
        } else {
          this.set(0, this.arith(reg, this.get(0), v));
        }
        return;
      }
      case 0xd9:
        switch (reg) {
          case 0:
            this.push(Fpu.fromFloat32(c.fpuRead32()));
            return;
          case 2:
          case 3:
            c.fpuWrite32(Fpu.toFloat32(this.get(0)));
            if (reg === 3) this.pop();
            return;
          case 4:
            this.loadEnvironment();
            return;
          case 5:
            this.cw = c.fpuRead16() | 0x40;
            this.updateSummary();
            return;
          case 6:
            this.storeEnvironment();
            this.cw |= 0x3f;
            return;
          case 7:
            c.fpuWrite16(this.cw);
            return;
          default:
            return;
        }
      case 0xdb:
        switch (reg) {
          case 0:
            this.push(c.fpuRead32());
            return;
          case 2:
          case 3: {
            c.fpuCheckWrite(4);
            const v = this.toInteger(this.get(0), 32);
            c.fpuWrite32(v === null ? 0x80000000 | 0 : v);
            if (reg === 3) this.pop();
            return;
          }
          case 5:
            this.push(this.readExtended(0));
            return;
          case 7:
            c.fpuCheckWrite(10);
            this.writeExtended(0, this.get(0));
            this.pop();
            return;
          default:
            return;
        }
      case 0xdd:
        switch (reg) {
          case 0:
            this.push(Fpu.fromFloat64(c.fpuRead32(0), c.fpuRead32(4)));
            return;
          case 2:
          case 3: {
            c.fpuCheckWrite(8);
            const [lo, hi] = Fpu.toFloat64(this.get(0));
            c.fpuWrite32(lo, 0);
            c.fpuWrite32(hi, 4);
            if (reg === 3) this.pop();
            return;
          }
          case 4: {
            const at = this.loadEnvironment();
            for (let i = 0; i < 8; i++) this.st[(this.top + i) & 7] = this.readExtended(at + i * 10);
            return;
          }
          case 6: {
            const at = this.storeEnvironment();
            for (let i = 0; i < 8; i++) this.writeExtended(at + i * 10, this.st[(this.top + i) & 7]);
            this.init();
            return;
          }
          case 7:
            c.fpuWrite16(this.status);
            return;
          default:
            return;
        }
      default:
        switch (reg) {
          case 0:
            this.push((c.fpuRead16() << 16) >> 16);
            return;
          case 2:
          case 3: {
            c.fpuCheckWrite(2);
            const v = this.toInteger(this.get(0), 16);
            c.fpuWrite16(v === null ? 0x8000 : v);
            if (reg === 3) this.pop();
            return;
          }
          case 4:
            this.push(this.readBcd());
            return;
          case 5:
            this.push(this.readInt64());
            return;
          case 6:
            this.writeBcd(this.get(0));
            this.pop();
            return;
          case 7: {
            c.fpuCheckWrite(8);
            this.writeInt64(this.toInteger(this.get(0), 64));
            this.pop();
            return;
          }
          default:
            return;
        }
    }
  }

  private registerForm(op: number, reg: number, i: number): void {
    switch (op) {
      case 0xd8:
        if (reg === 2 || reg === 3) {
          this.compare(this.get(0), this.get(i));
          if (reg === 3) this.pop();
        } else {
          this.set(0, this.arith(reg, this.get(0), this.get(i)));
        }
        return;
      case 0xd9:
        this.d9Register(reg, i);
        return;
      case 0xda:
        if (reg === 5 && i === 1) {
          this.compare(this.get(0), this.get(1), true);
          this.pop();
          this.pop();
        }
        return;
      case 0xdb:
        if (reg === 4) {
          if (i === 2) this.sw &= ~(0xff | BUSY);
          else if (i === 3) this.init();
        }
        return;
      case 0xdc:
      case 0xde:
        if (reg === 2 || reg === 3) {
          this.compare(this.get(0), this.get(i));
          if (reg === 3 || op === 0xde) this.pop();
          return;
        }
        if (op === 0xde && reg === 3) return;
        // ST(i) is the destination, and the subtract and divide forms are swapped.
        this.set(i, this.arith(reg >= 4 ? reg ^ 1 : reg, this.get(i), this.get(0)));
        if (op === 0xde) this.pop();
        return;
      case 0xdd:
        switch (reg) {
          case 0:
            this.empty |= 1 << ((this.top + i) & 7);
            return;
          case 2:
          case 3:
            this.set(i, this.get(0));
            if (reg === 3) this.pop();
            return;
          case 4:
          case 5:
            this.compare(this.get(0), this.get(i), true);
            if (reg === 5) this.pop();
            return;
          default:
            return;
        }
      default:
        if (reg === 4 && i === 0) this.cpu.fpuAx = this.status;
        else if (reg === 0) {
          this.empty |= 1 << ((this.top + i) & 7);
          this.pop();
        } else if (reg === 2 || reg === 3) {
          this.set(i, this.get(0));
          this.pop();
        }
    }
  }

  private d9Register(reg: number, i: number): void {
    switch (reg) {
      case 0:
        this.push(this.get(i));
        return;
      case 1: {
        const a = this.get(0);
        const b = this.get(i);
        this.set(0, b);
        this.set(i, a);
        return;
      }
      case 2:
      case 3:
        if (reg === 3) {
          this.set(i, this.get(0));
          this.pop();
        }
        return;
      case 4:
        switch (i) {
          case 0:
            this.set(0, -this.get(0));
            return;
          case 1:
            this.set(0, Math.abs(this.get(0)));
            return;
          case 4:
            this.compare(this.get(0), 0);
            return;
          case 5:
            this.examine();
            return;
          default:
            return;
        }
      case 5: {
        const constants = [1, LOG2_10, LOG2_E, Math.PI, LOG10_2, LN_2, 0];
        if (i < 7) this.push(constants[i]);
        return;
      }
      case 6:
        this.transcendental(i);
        return;
      default:
        this.arithmetic(i);
    }
  }

  /** D9 F0-F7. */
  private transcendental(i: number): void {
    switch (i) {
      case 0:
        this.set(0, 2 ** this.get(0) - 1);
        return;
      case 1: {
        const v = this.get(1) * Math.log2(this.get(0));
        this.pop();
        this.set(0, v);
        return;
      }
      case 2: {
        const v = this.get(0);
        if (Math.abs(v) >= 2 ** 63) {
          this.sw |= C2;
          return;
        }
        this.sw &= ~C2;
        this.set(0, Math.tan(v));
        this.push(1);
        return;
      }
      case 3: {
        const v = Math.atan2(this.get(1), this.get(0));
        this.pop();
        this.set(0, v);
        return;
      }
      case 4: {
        const v = this.get(0);
        if (v === 0) {
          this.exception(ZE);
          this.set(0, -Infinity);
          this.push(v);
          return;
        }
        if (!Number.isFinite(v)) {
          this.set(0, v !== v ? v : Infinity);
          this.push(v);
          return;
        }
        const e = Math.floor(Math.log2(Math.abs(v)));
        let m = v / 2 ** e;
        let exp = e;
        if (Math.abs(m) >= 2) {
          m /= 2;
          exp++;
        } else if (Math.abs(m) < 1) {
          m *= 2;
          exp--;
        }
        this.set(0, exp);
        this.push(m);
        return;
      }
      case 5:
        this.remainder(true);
        return;
      case 6:
        this.top = (this.top - 1) & 7;
        this.sw &= ~C1;
        return;
      default:
        this.top = (this.top + 1) & 7;
        this.sw &= ~C1;
    }
  }

  /** D9 F8-FF. */
  private arithmetic(i: number): void {
    switch (i) {
      case 0:
        this.remainder(false);
        return;
      case 1: {
        const v = this.get(1) * Math.log2(this.get(0) + 1);
        this.pop();
        this.set(0, v);
        return;
      }
      case 2: {
        const v = this.get(0);
        if (v < 0) this.exception(IE);
        this.set(0, Math.sqrt(v));
        return;
      }
      case 3: {
        const v = this.get(0);
        if (Math.abs(v) >= 2 ** 63) {
          this.sw |= C2;
          return;
        }
        this.sw &= ~C2;
        this.set(0, Math.sin(v));
        this.push(Math.cos(v));
        return;
      }
      case 4: {
        const v = this.get(0);
        const r = this.round(v);
        if (r !== v) this.exception(PE);
        this.set(0, r);
        return;
      }
      case 5: {
        const scale = Math.trunc(this.get(1));
        const v = this.get(0) * 2 ** scale;
        if (!Number.isFinite(v) && Number.isFinite(this.get(0))) this.exception(OE);
        this.set(0, v);
        return;
      }
      default: {
        const v = this.get(0);
        if (Math.abs(v) >= 2 ** 63) {
          this.sw |= C2;
          return;
        }
        this.sw &= ~C2;
        this.set(0, i === 6 ? Math.sin(v) : Math.cos(v));
      }
    }
  }

  private updateSummary(): void {
    if (this.sw & ~this.cw & 0x3f) this.sw |= ES | BUSY;
    else this.sw &= ~(ES | BUSY);
  }

  /** FSTENV: 14 bytes with a 16-bit operand size, 28 with 32; returns where the registers of FSAVE go. */
  private storeEnvironment(): number {
    const c = this.cpu;
    if (c.fpuOperandSize32) {
      c.fpuCheckWrite(28);
      c.fpuWrite32(this.cw | 0xffff0000, 0);
      c.fpuWrite32(this.status | 0xffff0000, 4);
      c.fpuWrite32(this.tagWord | 0xffff0000, 8);
      for (let at = 12; at < 28; at += 4) c.fpuWrite32(0, at);
      return 28;
    }
    c.fpuCheckWrite(14);
    c.fpuWrite16(this.cw, 0);
    c.fpuWrite16(this.status, 2);
    c.fpuWrite16(this.tagWord, 4);
    for (let at = 6; at < 14; at += 2) c.fpuWrite16(0, at);
    return 14;
  }

  private loadEnvironment(): number {
    const c = this.cpu;
    const wide = c.fpuOperandSize32;
    const step = wide ? 4 : 2;
    this.cw = c.fpuRead16(0) | 0x40;
    const status = c.fpuRead16(step);
    this.top = (status >> 11) & 7;
    this.sw = status & ~0x3800;
    this.setTagWord(c.fpuRead16(step * 2));
    this.updateSummary();
    return wide ? 28 : 14;
  }
}
