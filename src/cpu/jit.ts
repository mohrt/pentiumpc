/**
 * Translates runs of x86 instructions into JavaScript functions, so code the CPU runs often skips
 * fetching, decoding and dispatching. A block starts at a physical address, stays within its 4K
 * page and ends at a jump, call or return, or before an instruction it doesn't translate (those
 * run in the interpreter as before). The generated code works on the CPU's own state through the
 * same helpers the interpreter uses (memory access, lazy flags, shifts), with the instruction
 * pointer kept relative to the block's start so it doesn't depend on the code segment's base.
 */

/** A translated block: `count` instructions in `length` bytes, run by `fn(cpu, cpu.regs)`. */
export interface Block {
  readonly fn: (c: unknown, r: Int32Array) => void;
  readonly count: number;
  readonly length: number;
}

/** Tuning: whether blocks go on through instructions the interpreter runs. */
export const jitOptions = { interpretInBlocks: true };

/** Instructions in a block, at most. */
const MAX_INSTRUCTIONS = 32;
const ARITH_FLAGS = 0x8d5;
const DS = 3;
const SS = 2;
const SEGMENT_PREFIXES: Record<number, number> = { 0x26: 0, 0x2e: 1, 0x36: 2, 0x3e: 3, 0x64: 4, 0x65: 5 };

/** Thrown when an instruction runs past the end of the page. */
const END_OF_PAGE = { endOfPage: true } as const;

class Reader {
  constructor(
    private readonly ram: Uint8Array,
    public pos: number,
    /** The end of the page: instructions must end by here. */
    readonly limit: number,
  ) {}

  u8(): number {
    if (this.pos >= this.limit) throw END_OF_PAGE;
    return this.ram[this.pos++];
  }
  s8(): number {
    return (this.u8() << 24) >> 24;
  }
  u16(): number {
    return this.u8() | (this.u8() << 8);
  }
  s16(): number {
    return (this.u16() << 16) >> 16;
  }
  i32(): number {
    return this.u8() | (this.u8() << 8) | (this.u8() << 16) | (this.u8() << 24);
  }
}

// Register expressions by size.
const r8 = (i: number) => (i < 4 ? `(r[${i}] & 255)` : `((r[${i - 4}] >> 8) & 255)`);
const w8 = (i: number, v: string) => (i < 4 ? `r[${i}] = (r[${i}] & -256) | ((${v}) & 255);` : `r[${i - 4}] = (r[${i - 4}] & -65281) | (((${v}) & 255) << 8);`);
const r16 = (i: number) => `(r[${i}] & 65535)`;
const w16 = (i: number, v: string) => `r[${i}] = (r[${i}] & -65536) | ((${v}) & 65535);`;
const r32 = (i: number) => `r[${i}]`;
const w32 = (i: number, v: string) => `r[${i}] = ${v};`;
const readReg = (size: number, i: number) => (size === 1 ? r8(i) : size === 2 ? r16(i) : r32(i));
const writeReg = (size: number, i: number, v: string) => (size === 1 ? w8(i, v) : size === 2 ? w16(i, v) : w32(i, v));

interface Modrm {
  mod: number;
  reg: number;
  rm: number;
  /** The address expression (an offset in its segment), for memory operands. */
  ea: string;
  seg: number;
}

function decodeModrm(d: Reader, a32: boolean, segOverride: number): Modrm {
  const m = d.u8();
  const mod = m >> 6;
  const reg = (m >> 3) & 7;
  const rm = m & 7;
  if (mod === 3) return { mod, reg, rm, ea: '', seg: 0 };
  let seg = DS;
  let ea: string;
  if (!a32) {
    const bases = ['r[3] + r[6]', 'r[3] + r[7]', 'r[5] + r[6]', 'r[5] + r[7]', 'r[6]', 'r[7]', 'r[5]', 'r[3]'];
    let base = bases[rm];
    if (rm === 2 || rm === 3) seg = SS;
    let disp = 0;
    if (rm === 6 && mod === 0) {
      base = '';
      disp = d.u16();
    } else if (rm === 6) {
      seg = SS;
    }
    if (mod === 1) disp = d.s8();
    else if (mod === 2) disp = d.u16();
    ea = base ? `((${base} + ${disp}) & 65535)` : `${disp & 0xffff}`;
  } else {
    const parts: string[] = [];
    let disp = 0;
    if (rm === 4) {
      const sib = d.u8();
      const base = sib & 7;
      const index = (sib >> 3) & 7;
      if (base === 5 && mod === 0) disp = d.i32();
      else {
        parts.push(`r[${base}]`);
        if (base === 4 || base === 5) seg = SS;
      }
      if (index !== 4) parts.push(sib >> 6 ? `(r[${index}] << ${sib >> 6})` : `r[${index}]`);
    } else if (rm === 5 && mod === 0) {
      disp = d.i32();
    } else {
      parts.push(`r[${rm}]`);
      if (rm === 5) seg = SS;
    }
    if (mod === 1) disp = d.s8();
    else if (mod === 2) disp = d.i32();
    if (disp) parts.push(String(disp));
    ea = parts.length ? `((${parts.join(' + ')}) >>> 0)` : '0';
  }
  return { mod, reg, rm, ea, seg: segOverride >= 0 ? segOverride : seg };
}

/** An instruction's code, and how it relates to the block. */
interface Translation {
  code: string;
  /** It can fault, so the instruction's start must be known. */
  mayFault: boolean;
  /** It writes memory (which could be this block's own code). */
  writes: boolean;
  /** It transfers control: the block ends with it. */
  ends: boolean;
}

const bitsOf = (size: number) => size * 8;

/** Code reading an r/m operand (after `const a = <address>` for memory). */
function readRm(m: Modrm, size: number): string {
  if (m.mod === 3) return readReg(size, m.rm);
  return `c.read${bitsOf(size)}(${m.seg}, a)`;
}

function writeRm(m: Modrm, size: number, v: string): string {
  if (m.mod === 3) return writeReg(size, m.rm, v);
  return `c.write${bitsOf(size)}(${m.seg}, a, ${v});`;
}

const addressLine = (m: Modrm) => (m.mod === 3 ? '' : `const a = ${m.ea};`);

/** The ALU operation `kind` (ADD OR ADC SBB AND SUB XOR CMP) on locals x and y, leaving v and the lazy flags set. */
function alu(kind: number, top: number): string {
  switch (kind) {
    case 0:
      return `const v = (x + y) | 0; c.lazyOp = 0; c.lazyA = x; c.lazyB = y; c.lazyR = v; c.lazyTop = ${top}; c.lazyMask = ${ARITH_FLAGS};`;
    case 5:
    case 7:
      return `const v = (x - y) | 0; c.lazyOp = 1; c.lazyA = x; c.lazyB = y; c.lazyR = v; c.lazyTop = ${top}; c.lazyMask = ${ARITH_FLAGS};`;
    case 1:
    case 4:
    case 6: {
      const operator = kind === 1 ? '|' : kind === 4 ? '&' : '^';
      return `const v = x ${operator} y; c.lazyOp = 2; c.lazyR = v; c.lazyTop = ${top}; c.lazyMask = ${ARITH_FLAGS};`;
    }
    default:
      return `const v = c.alu(${kind}, x, y, ${top});`;
  }
}

const condition = (cc: number) => (cc === 4 ? 'c.zf()' : cc === 5 ? '!c.zf()' : `c.cond(${cc})`);

/** A near jump to `target` (an expression), as the interpreter's jumpNear does. */
const jump = (o32: boolean, target: string) =>
  `{ const t = ${o32 ? `(${target}) | 0` : `(${target}) & 65535`}; if ((t >>> 0) > c.segLimit[1]) c.gp(0); c.eip = t; }`;

/** Translates one instruction at the reader's position, or returns null if it isn't one the translator handles. */
function translate(d: Reader, code32: boolean, nextOffset: () => number): Translation | null {
  let o32 = code32;
  let a32 = code32;
  let segOverride = -1;
  let rep = 0;
  let op = d.u8();
  for (let prefixes = 0; ; prefixes++) {
    if (op === 0x66) o32 = !code32;
    else if (op === 0x67) a32 = !code32;
    else if (op in SEGMENT_PREFIXES) segOverride = SEGMENT_PREFIXES[op];
    else if (op === 0xf2 || op === 0xf3) rep = op === 0xf3 ? 3 : 2;
    else break;
    if (prefixes > 4) return null;
    op = d.u8();
  }
  // LOCK, and REP anywhere but on the string instructions, are left to the interpreter.
  if (op === 0xf0) return null;
  if (rep && !((op >= 0xa4 && op <= 0xa7) || (op >= 0xaa && op <= 0xaf))) return null;
  const size = o32 ? 4 : 2;
  const top = o32 ? 31 : 15;
  const done = (code: string, mayFault: boolean, writes = false, ends = false): Translation => ({ code, mayFault, writes, ends });

  // The ALU block 00-3D.
  if (op < 0x40 && (op & 7) < 6) {
    const kind = op >> 3;
    const form = op & 7;
    if (form === 4) return done(`const x = ${r8(0)}; const y = ${d.u8()}; ${alu(kind, 7)} ${kind !== 7 ? w8(0, 'v') : ''}`, false);
    if (form === 5) {
      const imm = o32 ? d.i32() : d.u16();
      return done(`const x = ${readReg(size, 0)}; const y = ${imm}; ${alu(kind, top)} ${kind !== 7 ? writeReg(size, 0, 'v') : ''}`, false);
    }
    const m = decodeModrm(d, a32, segOverride);
    const s = form & 1 ? size : 1;
    const t = s === 1 ? 7 : top;
    const mem = m.mod !== 3;
    if (form < 2) {
      const check = mem && (kind === 2 || kind === 3) ? `c.checkWriteSeg(${m.seg}, a, ${s});` : '';
      return done(`${addressLine(m)} ${check} const x = ${readRm(m, s)}; const y = ${readReg(s, m.reg)}; ${alu(kind, t)} ${kind !== 7 ? writeRm(m, s, 'v') : ''}`, mem, mem && kind !== 7);
    }
    return done(`${addressLine(m)} const x = ${readReg(s, m.reg)}; const y = ${readRm(m, s)}; ${alu(kind, t)} ${kind !== 7 ? writeReg(s, m.reg, 'v') : ''}`, mem);
  }

  switch (op) {
    case 0x40:
    case 0x41:
    case 0x42:
    case 0x43:
    case 0x44:
    case 0x45:
    case 0x46:
    case 0x47:
    case 0x48:
    case 0x49:
    case 0x4a:
    case 0x4b:
    case 0x4c:
    case 0x4d:
    case 0x4e:
    case 0x4f: {
      const i = op & 7;
      const fn = op < 0x48 ? 'inc' : 'dec';
      return done(o32 ? `r[${i}] = c.${fn}(r[${i}], 31);` : w16(i, `c.${fn}(${r16(i)}, 15)`), false);
    }
    case 0x50:
    case 0x51:
    case 0x52:
    case 0x53:
    case 0x54:
    case 0x55:
    case 0x56:
    case 0x57:
      return done(`c.push${o32 ? 32 : 16}(r[${op & 7}]);`, true, true);
    case 0x58:
    case 0x59:
    case 0x5a:
    case 0x5b:
    case 0x5c:
    case 0x5d:
    case 0x5e:
    case 0x5f:
      return done(`const v = c.pop${o32 ? 32 : 16}(); ${writeReg(size, op & 7, 'v')}`, true);
    case 0x68:
      return done(`c.push${o32 ? 32 : 16}(${o32 ? d.i32() : d.u16()});`, true, true);
    case 0x6a: {
      const imm = d.s8();
      return done(`c.push${o32 ? 32 : 16}(${o32 ? imm : imm & 0xffff});`, true, true);
    }
    case 0x80:
    case 0x81:
    case 0x82:
    case 0x83: {
      const m = decodeModrm(d, a32, segOverride);
      const kind = m.reg;
      const s = op === 0x81 || op === 0x83 ? size : 1;
      const t = s === 1 ? 7 : top;
      let imm: number;
      if (s === 1) imm = d.u8();
      else if (op === 0x83) imm = o32 ? d.s8() : d.s8() & 0xffff;
      else imm = o32 ? d.i32() : d.u16();
      const mem = m.mod !== 3;
      const check = mem && (kind === 2 || kind === 3) ? `c.checkWriteSeg(${m.seg}, a, ${s});` : '';
      return done(`${addressLine(m)} ${check} const x = ${readRm(m, s)}; const y = ${imm}; ${alu(kind, t)} ${kind !== 7 ? writeRm(m, s, 'v') : ''}`, mem, mem && kind !== 7);
    }
    case 0x84:
    case 0x85: {
      const m = decodeModrm(d, a32, segOverride);
      const s = op & 1 ? size : 1;
      return done(`${addressLine(m)} const x = ${readRm(m, s)}; const y = ${readReg(s, m.reg)}; ${alu(4, s === 1 ? 7 : top)}`, m.mod !== 3);
    }
    case 0x86:
    case 0x87: {
      const m = decodeModrm(d, a32, segOverride);
      const s = op & 1 ? size : 1;
      return done(`${addressLine(m)} const v = ${readRm(m, s)}; ${writeRm(m, s, readReg(s, m.reg))} ${writeReg(s, m.reg, 'v')}`, m.mod !== 3, m.mod !== 3);
    }
    case 0x88:
    case 0x89: {
      const m = decodeModrm(d, a32, segOverride);
      const s = op & 1 ? size : 1;
      const value = s === 1 ? r8(m.reg) : `r[${m.reg}]`;
      return done(`${addressLine(m)} ${writeRm(m, s, value)}`, m.mod !== 3, m.mod !== 3);
    }
    case 0x8a:
    case 0x8b: {
      const m = decodeModrm(d, a32, segOverride);
      const s = op & 1 ? size : 1;
      return done(`${addressLine(m)} const v = ${readRm(m, s)}; ${writeReg(s, m.reg, 'v')}`, m.mod !== 3);
    }
    case 0x8c: {
      const m = decodeModrm(d, a32, segOverride);
      if (m.reg > 5) return null;
      if (m.mod === 3) return done(writeReg(size, m.rm, `c.sel[${m.reg}]`), false);
      return done(`${addressLine(m)} c.write16(${m.seg}, a, c.sel[${m.reg}]);`, true, true);
    }
    case 0x8d: {
      const m = decodeModrm(d, a32, segOverride);
      if (m.mod === 3) return null;
      return done(writeReg(size, m.reg, m.ea), false);
    }
    case 0x90:
      return done('', false);
    case 0x91:
    case 0x92:
    case 0x93:
    case 0x94:
    case 0x95:
    case 0x96:
    case 0x97: {
      const i = op & 7;
      return done(`const v = ${readReg(size, i)}; ${writeReg(size, i, readReg(size, 0))} ${writeReg(size, 0, 'v')}`, false);
    }
    case 0x98:
      return done(o32 ? 'r[0] = (r[0] << 16) >> 16;' : w16(0, '(r[0] << 24) >> 24'), false);
    case 0x99:
      return done(o32 ? 'r[2] = r[0] >> 31;' : w16(2, '((r[0] << 16) >> 16) >> 16'), false);
    case 0xa0:
    case 0xa1:
    case 0xa2:
    case 0xa3: {
      const offset = a32 ? d.i32() >>> 0 : d.u16();
      const seg = segOverride >= 0 ? segOverride : DS;
      const s = op & 1 ? size : 1;
      if (op < 0xa2) return done(`const v = c.read${bitsOf(s)}(${seg}, ${offset}); ${writeReg(s, 0, 'v')}`, true);
      return done(`c.write${bitsOf(s)}(${seg}, ${offset}, ${s === 1 ? r8(0) : 'r[0]'});`, true, true);
    }
    case 0xa8:
      return done(`const x = ${r8(0)}; const y = ${d.u8()}; ${alu(4, 7)}`, false);
    case 0xa9:
      return done(`const x = ${readReg(size, 0)}; const y = ${o32 ? d.i32() : d.u16()}; ${alu(4, top)}`, false);
    case 0xb0:
    case 0xb1:
    case 0xb2:
    case 0xb3:
    case 0xb4:
    case 0xb5:
    case 0xb6:
    case 0xb7:
      return done(w8(op & 7, String(d.u8())), false);
    case 0xb8:
    case 0xb9:
    case 0xba:
    case 0xbb:
    case 0xbc:
    case 0xbd:
    case 0xbe:
    case 0xbf:
      return done(writeReg(size, op & 7, String(o32 ? d.i32() : d.u16())), false);
    case 0xc0:
    case 0xc1:
    case 0xd0:
    case 0xd1:
    case 0xd2:
    case 0xd3: {
      const m = decodeModrm(d, a32, segOverride);
      const s = op & 1 ? size : 1;
      const count = op === 0xc0 || op === 0xc1 ? String(d.u8()) : op === 0xd0 || op === 0xd1 ? '1' : '(r[1] & 255)';
      const mem = m.mod !== 3;
      const check = mem ? `c.checkWriteSeg(${m.seg}, a, ${s});` : '';
      return done(`${addressLine(m)} ${check} const v = c.shift(${m.reg}, ${readRm(m, s)}, ${count}, ${bitsOf(s)}); ${writeRm(m, s, 'v')}`, mem, mem);
    }
    case 0xc6:
    case 0xc7: {
      const m = decodeModrm(d, a32, segOverride);
      if (m.reg !== 0) return null;
      const s = op & 1 ? size : 1;
      const imm = s === 1 ? d.u8() : o32 ? d.i32() : d.u16();
      return done(`${addressLine(m)} ${writeRm(m, s, String(imm))}`, m.mod !== 3, m.mod !== 3);
    }
    case 0xfe:
    case 0xff: {
      const m = decodeModrm(d, a32, segOverride);
      if (op === 0xff && (m.reg === 2 || m.reg === 4)) {
        const next = nextOffset();
        const call = m.reg === 2 ? `c.push${o32 ? 32 : 16}(c.eip);` : '';
        return done(`${addressLine(m)} const v = ${readRm(m, size)}; c.eip = (e0 + ${next}) | 0; ${call} ${jump(o32, 'v')} return;`, true, m.reg === 2, true);
      }
      if (op === 0xff && m.reg === 6) return done(`${addressLine(m)} c.push${o32 ? 32 : 16}(${readRm(m, size)});`, true, true);
      if (m.reg > 1) return null;
      const s = op & 1 ? size : 1;
      const fn = m.reg === 0 ? 'inc' : 'dec';
      return done(`${addressLine(m)} const v = c.${fn}(${readRm(m, s)}, ${s === 1 ? 7 : top}); ${writeRm(m, s, 'v')}`, m.mod !== 3, m.mod !== 3);
    }
    case 0xc3:
      return done(`const v = c.pop${o32 ? 32 : 16}(); ${jump(o32, 'v')} return;`, true, false, true);
    case 0xe8: {
      const rel = o32 ? d.i32() : d.s16();
      const next = nextOffset();
      return done(`c.eip = (e0 + ${next}) | 0; c.push${o32 ? 32 : 16}(c.eip); ${jump(o32, `c.eip + ${rel}`)} return;`, true, true, true);
    }
    case 0xe9:
    case 0xeb: {
      const rel = op === 0xeb ? d.s8() : o32 ? d.i32() : d.s16();
      const next = nextOffset();
      return done(`c.eip = (e0 + ${next}) | 0; ${jump(o32, `c.eip + ${rel}`)} return;`, true, false, true);
    }
    case 0x06:
    case 0x0e:
    case 0x16:
    case 0x1e:
      return done(`c.push${o32 ? 32 : 16}(c.sel[${op >> 3}]);`, true, true);
    case 0x07:
    case 0x1f:
      // POP ES/DS: the selector's word is read; the segment loads before the stack pointer moves.
      return done(`const v = c.peek(0, 2); c.loadSeg(${op >> 3}, v); c.setSp(c.sp + ${size});`, true);
    case 0x8e: {
      const m = decodeModrm(d, a32, segOverride);
      if (m.reg === 1 || m.reg === 2 || m.reg > 5) return null;
      return done(`${addressLine(m)} c.loadSeg(${m.reg}, ${readRm(m, 2)});`, true);
    }
    case 0x69:
    case 0x6b: {
      const m = decodeModrm(d, a32, segOverride);
      const imm = op === 0x6b ? d.s8() : o32 ? d.i32() : d.s16();
      return done(`${addressLine(m)} c.o32 = ${o32}; const v = c.imulTruncated(${readRm(m, size)}, ${imm}); ${writeReg(size, m.reg, 'v')}`, m.mod !== 3);
    }
    case 0x9e:
      return done('c.writeFlags((r[0] >> 8) & 255, 0xd5);', false);
    case 0x9f:
      return done(`${w8(4, '(c.getEflags() & 0xd5) | 2')}`, false);
    case 0xa4:
    case 0xa5:
    case 0xa6:
    case 0xa7:
    case 0xaa:
    case 0xab:
    case 0xac:
    case 0xad:
    case 0xae:
    case 0xaf:
      return done(`c.o32 = ${o32}; c.a32 = ${a32}; c.segOv = ${segOverride}; c.rep = ${rep}; c.stringOp(${op});`, true, true);
    case 0xc2: {
      const imm = d.u16();
      return done(`const v = c.pop${o32 ? 32 : 16}(); c.setSp(c.sp + ${imm}); ${jump(o32, 'v')} return;`, true, false, true);
    }
    case 0xe0:
    case 0xe1:
    case 0xe2:
    case 0xe3: {
      const rel = d.s8();
      const next = nextOffset();
      const count = a32 ? 'r[1]' : '(r[1] & 65535)';
      const setCount = a32 ? 'r[1] = (r[1] - 1) | 0;' : w16(1, 'r[1] - 1');
      const test =
        op === 0xe3 ? `${count} === 0` : op === 0xe2 ? `${count} !== 0` : op === 0xe1 ? `${count} !== 0 && c.zf()` : `${count} !== 0 && !c.zf()`;
      return done(`c.eip = (e0 + ${next}) | 0; ${op !== 0xe3 ? setCount : ''} if (${test}) ${jump(o32, `c.eip + ${rel}`)} return;`, true, false, true);
    }
    case 0xf5:
      return done('c.setFlag(1, c.cf() === 0);', false);
    case 0xf8:
    case 0xf9:
      return done(`c.setFlag(1, ${op === 0xf9});`, false);
    case 0xfc:
      return done('c.flags &= ~0x400;', false);
    case 0xfd:
      return done('c.flags |= 0x400;', false);
    case 0xf6:
    case 0xf7: {
      const m = decodeModrm(d, a32, segOverride);
      const s = op & 1 ? size : 1;
      const t = s === 1 ? 7 : top;
      if (m.reg <= 1) {
        const imm = s === 1 ? d.u8() : o32 ? d.i32() : d.u16();
        return done(`${addressLine(m)} const x = ${readRm(m, s)}; const y = ${imm}; ${alu(4, t)}`, m.mod !== 3);
      }
      if (m.reg === 2) return done(`${addressLine(m)} ${writeRm(m, s, `~${readRm(m, s)}`)}`, m.mod !== 3, m.mod !== 3);
      if (m.reg === 3) {
        return done(
          `${addressLine(m)} const x = ${readRm(m, s)}; const v = -x | 0; ${writeRm(m, s, 'v')} c.lazyOp = 1; c.lazyA = 0; c.lazyB = x; c.lazyR = v; c.lazyTop = ${t}; c.lazyMask = ${ARITH_FLAGS};`,
          m.mod !== 3,
          m.mod !== 3,
        );
      }
      return null;
    }
    case 0x0f:
      return translate0f(d, o32, a32, segOverride, nextOffset, done);
    default:
      if (op >= 0x70 && op <= 0x7f) {
        const rel = d.s8();
        const next = nextOffset();
        return done(`c.eip = (e0 + ${next}) | 0; if (${condition(op & 15)}) ${jump(o32, `c.eip + ${rel}`)} return;`, true, false, true);
      }
      return null;
  }
}

function translate0f(
  d: Reader,
  o32: boolean,
  a32: boolean,
  segOverride: number,
  nextOffset: () => number,
  done: (code: string, mayFault: boolean, writes?: boolean, ends?: boolean) => Translation,
): Translation | null {
  const op = d.u8();
  const size = o32 ? 4 : 2;
  if (op >= 0x80 && op <= 0x8f) {
    const rel = o32 ? d.i32() : d.s16();
    const next = nextOffset();
    return done(`c.eip = (e0 + ${next}) | 0; if (${condition(op & 15)}) ${jump(o32, `c.eip + ${rel}`)} return;`, true, false, true);
  }
  if (op >= 0x90 && op <= 0x9f) {
    const m = decodeModrm(d, a32, segOverride);
    return done(`${addressLine(m)} ${writeRm(m, 1, `${condition(op & 15)} ? 1 : 0`)}`, m.mod !== 3, m.mod !== 3);
  }
  if (op >= 0x40 && op <= 0x4f) {
    const m = decodeModrm(d, a32, segOverride);
    return done(`${addressLine(m)} const v = ${readRm(m, size)}; if (${condition(op & 15)}) ${writeReg(size, m.reg, 'v')}`, m.mod !== 3);
  }
  if (op >= 0xc8 && op <= 0xcf) {
    const i = op & 7;
    return done(`const v = r[${i}]; r[${i}] = ((v & 255) << 24) | ((v & 65280) << 8) | ((v >>> 8) & 65280) | (v >>> 24);`, false);
  }
  switch (op) {
    case 0xa0:
    case 0xa8:
      return done(`c.push${o32 ? 32 : 16}(c.sel[${op === 0xa0 ? 4 : 5}]);`, true, true);
    case 0xa1:
    case 0xa9:
      return done(`const v = c.peek(0, 2); c.loadSeg(${op === 0xa1 ? 4 : 5}, v); c.setSp(c.sp + ${size});`, true);
    case 0xaf: {
      const m = decodeModrm(d, a32, segOverride);
      return done(`${addressLine(m)} c.o32 = ${o32}; const v = c.imulTruncated(${readReg(size, m.reg)}, ${readRm(m, size)}); ${writeReg(size, m.reg, 'v')}`, m.mod !== 3);
    }
    case 0xb6:
    case 0xb7:
    case 0xbe:
    case 0xbf: {
      const m = decodeModrm(d, a32, segOverride);
      const s = op & 1 ? 2 : 1;
      let v = readRm(m, s);
      if (op === 0xbe) v = `((${v} << 24) >> 24)`;
      if (op === 0xbf) v = `((${v} << 16) >> 16)`;
      return done(`${addressLine(m)} const v = ${v}; ${writeReg(size, m.reg, 'v')}`, m.mod !== 3);
    }
    default:
      return null;
  }
}

// One-byte opcodes with a ModR/M byte, and the size of their immediate: 1 byte, 'v' (16 or 32 by
// the operand size), or another fixed size. Opcodes left out aren't measured (the block stops there).
const ONE_BYTE_MODRM = new Set([
  ...[0x00, 0x08, 0x10, 0x18, 0x20, 0x28, 0x30, 0x38].flatMap((b) => [b, b + 1, b + 2, b + 3]),
  0x62, 0x63, 0x69, 0x6b, ...Array.from({ length: 16 }, (_, i) => 0x80 + i), 0xc0, 0xc1, 0xc4, 0xc5, 0xc6, 0xc7,
  0xd0, 0xd1, 0xd2, 0xd3, 0xd8, 0xd9, 0xda, 0xdb, 0xdc, 0xdd, 0xde, 0xdf, 0xf6, 0xf7, 0xfe, 0xff,
]);
const IMM8 = new Set([0x04, 0x0c, 0x14, 0x1c, 0x24, 0x2c, 0x34, 0x3c, 0x6a, 0x6b, 0x80, 0x82, 0x83, 0xa8, 0xc0, 0xc1, 0xc6, 0xcd, 0xd4, 0xd5, 0xe4, 0xe5, 0xe6, 0xe7, ...Array.from({ length: 8 }, (_, i) => 0xb0 + i)]);
const IMMV = new Set([0x05, 0x0d, 0x15, 0x1d, 0x25, 0x2d, 0x35, 0x3d, 0x68, 0x69, 0x81, 0xa9, 0xc7, ...Array.from({ length: 8 }, (_, i) => 0xb8 + i)]);
/** One-byte opcodes with neither a ModR/M byte nor an immediate that the interpreter can run inside a block. */
const ONE_BYTE_PLAIN = new Set([
  0x06, 0x07, 0x0e, 0x16, 0x17, 0x1e, 0x1f, 0x27, 0x2f, 0x37, 0x3f, ...Array.from({ length: 0x20 }, (_, i) => 0x40 + i), 0x60, 0x61,
  0x6c, 0x6d, 0x6e, 0x6f, ...Array.from({ length: 16 }, (_, i) => 0x90 + i), 0xa4, 0xa5, 0xa6, 0xa7, 0xaa, 0xab, 0xac, 0xad,
  0xae, 0xaf, 0xc3, 0xc9, 0xcb, 0xcc, 0xce, 0xcf, 0xd6, 0xd7, 0xec, 0xed, 0xee, 0xef, 0xf4, 0xf5, 0xf8, 0xf9, 0xfa, 0xfb, 0xfc, 0xfd,
]);
const TWO_BYTE_MODRM = new Set([0x00, 0x01, 0x02, 0x03, 0xa3, 0xa4, 0xa5, 0xab, 0xac, 0xad, 0xaf, 0xb0, 0xb1, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xba, 0xbb, 0xbc, 0xbd, 0xbe, 0xbf, 0xc0, 0xc1, 0xc7, ...Array.from({ length: 16 }, (_, i) => 0x40 + i), ...Array.from({ length: 16 }, (_, i) => 0x90 + i)]);
const TWO_BYTE_PLAIN = new Set([0x06, 0x08, 0x09, 0x30, 0x31, 0x32, 0xa0, 0xa1, 0xa2, 0xa8, 0xa9, ...Array.from({ length: 8 }, (_, i) => 0xc8 + i)]);

/** Interpreted instructions after which a block stops: far transfers, interrupts, returns from them, HLT, and the system instructions. */
function endsBlock(ram: Uint8Array, at: number, end: number): boolean {
  let op = ram[at];
  while ([0x26, 0x2e, 0x36, 0x3e, 0x64, 0x65, 0x66, 0x67, 0xf2, 0xf3].includes(op) && at < end - 1) op = ram[++at];
  if ([0x9a, 0xca, 0xcb, 0xcc, 0xcd, 0xce, 0xcf, 0xea, 0xf4].includes(op)) return true;
  if (op === 0xff) {
    const reg = (ram[at + 1] >> 3) & 7;
    return reg === 3 || reg === 5;
  }
  return op === 0x0f && [0x00, 0x01, 0x06, 0x08, 0x09, 0x20, 0x21, 0x22, 0x23, 0x30, 0x32].includes(ram[at + 1]);
}

/** Skips a ModR/M byte and its SIB and displacement. */
function skipModrm(d: Reader, a32: boolean): number {
  const m = d.u8();
  const mod = m >> 6;
  const rm = m & 7;
  if (mod === 3) return m;
  if (a32) {
    let base = rm;
    if (rm === 4) base = d.u8() & 7;
    if (mod === 0 && base === 5) d.pos += 4;
    else if (mod === 1) d.pos += 1;
    else if (mod === 2) d.pos += 4;
  } else if ((mod === 0 && rm === 6) || mod === 2) {
    d.pos += 2;
  } else if (mod === 1) {
    d.pos += 1;
  }
  if (d.pos > d.limit) throw END_OF_PAGE;
  return m;
}

/** The length of the instruction at the reader, or -1 for one that isn't measured; moves the reader past it. */
function instructionLength(d: Reader, code32: boolean): number {
  const start = d.pos;
  let o32 = code32;
  let a32 = code32;
  let op = d.u8();
  for (let prefixes = 0; [0x26, 0x2e, 0x36, 0x3e, 0x64, 0x65, 0x66, 0x67, 0xf2, 0xf3].includes(op); prefixes++) {
    if (op === 0x66) o32 = !code32;
    if (op === 0x67) a32 = !code32;
    if (prefixes > 4) return -1;
    op = d.u8();
  }
  const immV = o32 ? 4 : 2;
  if (op === 0x0f) {
    const op2 = d.u8();
    if (TWO_BYTE_MODRM.has(op2)) {
      skipModrm(d, a32);
      if (op2 === 0xa4 || op2 === 0xac || op2 === 0xba) d.pos++;
    } else if (op2 === 0x20 || op2 === 0x21 || op2 === 0x22 || op2 === 0x23) {
      d.pos++;
    } else if (op2 >= 0x80 && op2 <= 0x8f) {
      d.pos += immV;
    } else if (!TWO_BYTE_PLAIN.has(op2)) {
      return -1;
    }
  } else if (ONE_BYTE_MODRM.has(op)) {
    const m = skipModrm(d, a32);
    if (IMM8.has(op)) d.pos += 1;
    else if (IMMV.has(op)) d.pos += immV;
    else if ((op === 0xf6 || op === 0xf7) && ((m >> 3) & 7) <= 1) d.pos += op === 0xf6 ? 1 : immV;
  } else if (IMM8.has(op)) {
    d.pos += 1;
  } else if (IMMV.has(op)) {
    d.pos += immV;
  } else if (op >= 0xa0 && op <= 0xa3) {
    d.pos += a32 ? 4 : 2;
  } else if (op === 0xc2 || op === 0xca) {
    d.pos += 2;
  } else if (op === 0xc8) {
    d.pos += 3;
  } else if (op === 0x9a || op === 0xea) {
    d.pos += immV + 2;
  } else if (!ONE_BYTE_PLAIN.has(op)) {
    return -1;
  }
  if (d.pos > d.limit) throw END_OF_PAGE;
  return d.pos - start;
}

/** Translates the block at `phys` (in `ram`), or returns null if its first instruction isn't one the translator handles. */
export function compileBlock(ram: Uint8Array, phys: number, code32: boolean): Block | null {
  const end = (phys & ~0xfff) + 0x1000;
  const d = new Reader(ram, phys, end);
  const lines: string[] = ['const e0 = c.eip; const cs0 = c.csBase; const page0 = c.fetchPage;'];
  let count = 0;
  let translated = 0;
  let ended = false;
  while (count < MAX_INSTRUCTIONS) {
    const start = d.pos;
    let t: Translation | null;
    try {
      t = translate(d, code32, () => d.pos - phys);
    } catch (error) {
      if (error !== END_OF_PAGE) throw error;
      t = null;
    }
    if (!t) {
      // The interpreter runs this one; the block goes on if it just moved to the next instruction
      // in the same code segment and page, without halting, enabling a pending interrupt, or
      // single-stepping (and without writing this block's code).
      d.pos = start;
      let length: number;
      try {
        length = instructionLength(d, code32);
      } catch (error) {
        if (error !== END_OF_PAGE) throw error;
        length = -1;
      }
      if (length < 0 || !jitOptions.interpretInBlocks) {
        d.pos = start;
        break;
      }
      const offset = start - phys;
      count++;
      if (endsBlock(ram, start, end)) {
        lines.push(`c.eip = (e0 + ${offset}) | 0; c.step(); return;`);
        ended = true;
        break;
      }
      lines.push(
        `c.eip = (e0 + ${offset}) | 0; c.step(); if (c.eip !== ((e0 + ${offset + length}) | 0) || c.csBase !== cs0 || c.fetchPage !== page0 || c.code32 !== ${code32} || c.halted || c.inhibit || c.jitDirty || (c.flags & 0x100) !== 0 || (c.irqLine && (c.flags & 0x200) !== 0)) return;`,
      );
      continue;
    }
    translated++;
    const offset = start - phys;
    const next = d.pos - phys;
    let code = t.code;
    if (t.mayFault) code = `c.startEip = (e0 + ${offset}) | 0; c.startEsp = r[4]; ${code}`;
    // A write to this block's own page ends it (the CPU has dropped it); the rest may have changed.
    if (t.writes && !t.ends) code += ` if (c.jitDirty) { c.eip = (e0 + ${next}) | 0; return; }`;
    lines.push(`{ ${code} }`);
    count++;
    if (t.ends) {
      ended = true;
      break;
    }
  }
  if (translated === 0) return null;
  if (!ended) lines.push(`c.eip = (e0 + ${d.pos - phys}) | 0;`);
  const fn = new Function('c', 'r', lines.join('\n')) as Block['fn'];
  return { fn, count, length: d.pos - phys };
}
