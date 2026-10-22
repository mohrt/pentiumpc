import {
  AC,
  AF,
  ARITH_FLAGS,
  BP,
  BR,
  CF,
  CR0_EM,
  CR0_ET,
  CR0_MP,
  CR0_NE,
  CR0_PE,
  CR0_PG,
  CR0_TS,
  CR0_WP,
  CR4_PSE,
  CR4_TSD,
  CS,
  DB,
  DE,
  DF,
  DOUBLE_FAULT,
  DS,
  EAX,
  EBP,
  EBX,
  ECX,
  EDI,
  EDX,
  EFLAGS_MASK,
  ES,
  ESI,
  ESP,
  FS,
  GP,
  GS,
  ID,
  IF,
  IOPL,
  NM,
  NP,
  NT,
  OF,
  OVERFLOW,
  PAGE_FAULT,
  PF,
  RF,
  SF,
  SS,
  SS_FAULT,
  TF,
  TS,
  UD,
  VIF,
  VIP,
  VM,
  ZF,
} from './constants';
import { Fpu } from './fpu';
import { compileBlock, type Block } from './jit';

/** What the CPU is plugged into: memory, I/O ports and the interrupt controller. */
export interface CpuHost {
  /** Memory the CPU reads and writes directly: RAM, and after it whatever else `directPage` maps (video memory). */
  readonly ram: Uint8Array;
  /** Where the 4K physical page at `address` is in `ram`, or -1 if it isn't directly accessible (devices, ROM). */
  directPage(address: number): number;
  readMemory8(address: number): number;
  writeMemory8(address: number, value: number): void;
  in8(port: number): number;
  in16(port: number): number;
  in32(port: number): number;
  out8(port: number, value: number): void;
  out16(port: number, value: number): void;
  out32(port: number, value: number): void;
  /** The vector of the interrupt the PIC is raising, acknowledging it (or -1 if it went away). */
  acknowledgeInterrupt(): number;
  /** A triple fault: the CPU shuts down, which a PC turns into a reset. */
  shutdown(): void;
  /** An x87 error with CR0.NE clear, reported through FERR# (IRQ 13 on a PC). */
  fpuError(): void;
}

/** Thrown to abandon an instruction that faulted; the CPU catches it and delivers the exception. */
const FAULT = { fault: true } as const;

// TLB entries: the physical page, and in the low bits what it allows.
const T_SREAD = 1;
const T_UREAD = 2;
const T_SWRITE = 4;
const T_UWRITE = 8;
const T_RAM = 16;
const PAGE_MASK = ~0xfff;
/** The D/B bit of a cached segment's attributes: 32-bit code, or a 32-bit stack. */
const SEG_BIG = 0x4000;
/** Pages remembered for flushing one by one; beyond this the whole TLB is cleared. */
const TLB_TRACK = 4096;
/** Translated blocks kept at most; beyond this they are all dropped and translated again as needed. */
const BLOCK_SLOTS = 1 << 18;
const SLOT_SHIFT = 32 - 18;
/** The hash table is cleared (and blocks translated again as needed) when this full. */
const MAX_BLOCKS = BLOCK_SLOTS * 0.7;
/** A page whose code has been overwritten this often runs interpreted (it's code mixed with busy data, or generated code). */
const MAX_REWRITES = 8;

// How the lazily computed flags were last set.
const L_ADD = 0;
const L_SUB = 1;
const L_LOGIC = 2;

// Kinds of interrupt.
const INT_SOFT = 0;
const INT_EXCEPTION = 1;
const INT_EXTERNAL = 2;

// Why a task switch happens.
const TASK_JMP = 0;
const TASK_CALL = 1;
const TASK_IRET = 2;
const TASK_INT = 3;

/** 1 for bytes with even parity (PF). */
const PARITY = Uint8Array.from({ length: 256 }, (_, n) => {
  let bits = 0;
  for (let b = n; b; b >>= 1) bits += b & 1;
  return bits & 1 ? 0 : 1;
});

/** Prefix bytes: segment overrides, operand and address size, LOCK and REP. */
const PREFIXES = Uint8Array.from({ length: 256 }, (_, op) => ([0x26, 0x2e, 0x36, 0x3e, 0x64, 0x65, 0x66, 0x67, 0xf0, 0xf2, 0xf3].includes(op) ? 1 : 0));

/** Exceptions that push an error code. */
const HAS_ERROR_CODE = new Set([DOUBLE_FAULT, TS, NP, SS_FAULT, GP, PAGE_FAULT, 17]);
const CONTRIBUTORY = new Set([DE, TS, NP, SS_FAULT, GP]);

/** CPUID 1: family 5 (Pentium), model 2, stepping 12. */
const CPU_SIGNATURE = 0x52c;
/** CPUID 1 EDX: FPU, PSE, TSC, MSR and CMPXCHG8B. */
const CPU_FEATURES = (1 << 0) | (1 << 3) | (1 << 4) | (1 << 5) | (1 << 8);

const sx8 = (v: number) => (v << 24) >> 24;
const sx16 = (v: number) => (v << 16) >> 16;

/**
 * An x86 processor: the 386's real, protected and virtual 8086 modes with
 * paging, the 486's additions (BSWAP, CMPXCHG, XADD, INVLPG, CR0.WP) and the
 * Pentium's CPUID, RDTSC, MSRs and CMPXCHG8B, with an x87 FPU. Instructions
 * are interpreted one at a time. Arithmetic flags are worked out only when
 * something reads them, and linear addresses go through a TLB that also says
 * which pages are plain RAM, read and written directly.
 */
export class Cpu {
  readonly regs = new Int32Array(8);
  /** The instruction pointer (kept as a signed 32-bit number; `>>> 0` gives EIP). */
  eip = 0;
  // Segment registers and their descriptor caches.
  readonly sel = [0, 0, 0, 0, 0, 0];
  readonly segBase = [0, 0, 0, 0, 0, 0];
  readonly segLimit = [0, 0, 0, 0, 0, 0];
  /** The descriptor's access byte, with its flags (AVL 0x1000, D/B 0x4000, G 0x8000) above. */
  readonly segAttr = [0, 0, 0, 0, 0, 0];
  // The offsets each segment allows for reads and for writes (inclusive; empty for unusable segments).
  private readonly rLow = [0, 0, 0, 0, 0, 0];
  private readonly rHigh = [0, 0, 0, 0, 0, 0];
  private readonly wLow = [0, 0, 0, 0, 0, 0];
  private readonly wHigh = [0, 0, 0, 0, 0, 0];
  private csBase = 0;
  cpl = 0;
  private user = false;
  code32 = false;
  stack32 = false;

  cr0 = CR0_ET;
  cr2 = 0;
  cr3 = 0;
  cr4 = 0;
  readonly dr = [0, 0, 0, 0, 0, 0, 0xffff0ff0, 0x400];
  gdtBase = 0;
  gdtLimit = 0xffff;
  idtBase = 0;
  idtLimit = 0x3ff;
  ldtSel = 0;
  ldtBase = 0;
  ldtLimit = 0;
  trSel = 0;
  trBase = 0;
  trLimit = 0;
  /** The TSS descriptor's type (9 or 11 for a 386 TSS, 1 or 3 for a 286 one). */
  trType = 0;

  /** EFLAGS, except the arithmetic flags in `lazyMask`, which come from the last operation. */
  private flags = 2;
  private lazyMask = 0;
  private lazyOp = L_LOGIC;
  private lazyA = 0;
  private lazyB = 0;
  private lazyR = 0;
  /** The top bit of the last operation's size (7, 15 or 31). */
  private lazyTop = 31;

  halted = false;
  /** The PIC's interrupt request line. */
  irqLine = false;
  /** Instructions run (string instruction repeats each count); the time base for RDTSC and the machine. */
  cycles = 0;
  private tscOffset = 0;
  /** Bit 20 of physical addresses: all ones with the A20 gate open, bit 20 clear when it is closed. */
  private a20Mask = -1;
  readonly fpu: Fpu;

  // The instruction being decoded.
  private o32 = false;
  private a32 = false;
  private segOv = -1;
  private rep = 0;
  private lock = false;
  private modrm = 0;
  private ea = 0;
  private eaSeg = DS;
  private startEip = 0;
  private startEsp = 0;
  private inhibit = false;
  private budget = 0;

  private faultVector = 0;
  private faultCode = -1;
  /** The exception being delivered (-1 when none), for double faults. */
  private delivering = -1;

  private ram: Uint8Array;
  private ram32: Int32Array;
  private readonly tlb = new Int32Array(1 << 20);
  private readonly tlbPages = new Int32Array(TLB_TRACK);
  private tlbCount = 0;
  private fetchPage = -1;
  private fetchPhys = 0;
  /** The next instruction byte's place in `ram`, valid while below `fpEnd` (the end of its page). */
  private fp = 0;
  private fpEnd = 0;
  /** Translating code into JavaScript (off, everything is interpreted). */
  jitEnabled = true;
  /** How many times a block's first instruction runs before the block is translated. */
  jitThreshold = 16;
  /** Translated blocks by physical address and code size (null: its first instruction isn't translatable). */
  // A hash table of blocks: the key (physical address and code size) in each slot, the block
  // (undefined until translated, null when untranslatable) and how often the address has run.
  private readonly slotKey = new Float64Array(BLOCK_SLOTS).fill(-1);
  private readonly slotBlock: (Block | null | undefined)[] = new Array<Block | null | undefined>(BLOCK_SLOTS).fill(undefined);
  private readonly slotHits = new Int32Array(BLOCK_SLOTS);
  private slotsUsed = 0;
  private readonly usedSlots = new Int32Array(BLOCK_SLOTS);
  /** The slots of each page's blocks. */
  private readonly pageSlots = new Map<number, number[]>();
  /** One bit for each byte of `ram` that translated code came from. */
  private codeBits: Uint32Array;
  /** How often each page's code has been overwritten; pages rewritten often aren't translated any more. */
  private readonly rewrites = new Map<number, number>();
  /** Pages of `ram` with translated code (a nonzero entry sends writes to `codeWrite`). */
  private codePages: Uint8Array;
  /** Set when a block's page is written, so a running block (which reads it) can stop. */
  jitDirty = false;
  /**
   * Checks every translated block against the interpreter, calling this with what differs
   * (slow; for finding translation bugs). Set it with `checkJit`.
   */
  private jitCheck: ((report: string) => void) | null = null;
  /** RAM written while a block is checked: each index, then the byte it held. */
  private journal: number[] | null = null;
  /** Port and device memory accesses, counted while checking blocks: a block that made any can't run twice. */
  private deviceAccesses = 0;
  // The descriptor last read by readDescriptor.
  private descLo = 0;
  private descHi = 0;
  private descAddr = 0;

  constructor(private host: CpuHost) {
    this.ram = host.ram;
    this.ram32 = new Int32Array(host.ram.buffer, host.ram.byteOffset, host.ram.byteLength >> 2);
    this.codePages = new Uint8Array((host.ram.length >>> 12) + 1);
    this.codeBits = new Uint32Array((host.ram.length >>> 5) + 1);
    this.fpu = new Fpu(this);
    this.reset();
  }

  /** The host's RAM was replaced (a new size). */
  attachRam(): void {
    this.ram = this.host.ram;
    this.ram32 = new Int32Array(this.ram.buffer, this.ram.byteOffset, this.ram.byteLength >> 2);
    this.flushBlocks();
    this.codePages = new Uint8Array((this.ram.length >>> 12) + 1);
    this.codeBits = new Uint32Array((this.ram.length >>> 5) + 1);
    this.flushTlb();
  }

  reset(): void {
    this.regs.fill(0);
    this.regs[EDX] = CPU_SIGNATURE;
    this.flags = 2;
    this.lazyMask = 0;
    this.cr0 = 0x60000000 | CR0_ET;
    this.cr2 = this.cr3 = this.cr4 = 0;
    this.gdtBase = this.idtBase = 0;
    this.gdtLimit = 0xffff;
    this.idtLimit = 0x3ff;
    this.ldtSel = this.ldtBase = this.ldtLimit = 0;
    this.trSel = this.trBase = this.trLimit = 0;
    this.trType = 0xb;
    this.dr.fill(0);
    this.dr[6] = 0xffff0ff0;
    this.dr[7] = 0x400;
    for (let seg = 0; seg < 6; seg++) this.setSegCache(seg, 0, 0, 0xffff, 0x93);
    this.setSegCache(CS, 0xf000, 0xffff0000, 0xffff, 0x93);
    this.eip = 0xfff0;
    this.setCpl(0);
    this.halted = false;
    this.inhibit = false;
    this.delivering = -1;
    this.flushTlb();
    this.flushBlocks();
    this.fpu.reset();
  }

  /** Opens or closes the A20 gate. */
  setA20(enabled: boolean): void {
    const mask = enabled ? -1 : ~(1 << 20);
    if (mask === this.a20Mask) return;
    this.a20Mask = mask;
    this.flushTlb();
  }

  get a20(): boolean {
    return this.a20Mask === -1;
  }

  get protectedMode(): boolean {
    return (this.cr0 & CR0_PE) !== 0;
  }

  get vm86(): boolean {
    return (this.flags & VM) !== 0;
  }

  // --- Flags ---------------------------------------------------------------------------

  private cf(): number {
    if (!(this.lazyMask & CF)) return this.flags & CF;
    const a = this.lazyA;
    const b = this.lazyB;
    const r = this.lazyR;
    if (this.lazyOp === L_ADD) return (((a & b) | ((a | b) & ~r)) >>> this.lazyTop) & 1;
    if (this.lazyOp === L_SUB) return (((~a & b) | ((~a | b) & r)) >>> this.lazyTop) & 1;
    return 0;
  }

  private zf(): boolean {
    if (!(this.lazyMask & ZF)) return (this.flags & ZF) !== 0;
    return this.lazyR << (31 - this.lazyTop) === 0;
  }

  private sf(): boolean {
    if (!(this.lazyMask & SF)) return (this.flags & SF) !== 0;
    return ((this.lazyR >>> this.lazyTop) & 1) !== 0;
  }

  private of(): boolean {
    if (!(this.lazyMask & OF)) return (this.flags & OF) !== 0;
    const a = this.lazyA;
    const b = this.lazyB;
    const r = this.lazyR;
    if (this.lazyOp === L_ADD) return ((((a ^ r) & (b ^ r)) >>> this.lazyTop) & 1) !== 0;
    if (this.lazyOp === L_SUB) return ((((a ^ b) & (a ^ r)) >>> this.lazyTop) & 1) !== 0;
    return false;
  }

  private pf(): boolean {
    if (!(this.lazyMask & PF)) return (this.flags & PF) !== 0;
    return PARITY[this.lazyR & 0xff] !== 0;
  }

  private af(): boolean {
    if (!(this.lazyMask & AF)) return (this.flags & AF) !== 0;
    if (this.lazyOp === L_LOGIC) return false;
    return ((this.lazyA ^ this.lazyB ^ this.lazyR) & 0x10) !== 0;
  }

  /** The whole EFLAGS register. */
  getEflags(): number {
    let f = this.flags & ~this.lazyMask;
    const lazy = this.lazyMask;
    if (lazy) {
      if (lazy & CF) f |= this.cf();
      if (lazy & PF && this.pf()) f |= PF;
      if (lazy & AF && this.af()) f |= AF;
      if (lazy & ZF && this.zf()) f |= ZF;
      if (lazy & SF && this.sf()) f |= SF;
      if (lazy & OF && this.of()) f |= OF;
    }
    return f | 2;
  }

  /** Sets EFLAGS outright (the caller decides which bits may change). */
  setEflags(value: number): void {
    this.flags = (value & EFLAGS_MASK) | 2;
    this.lazyMask = 0;
  }

  /** Changes only the bits in `mask`. */
  private writeFlags(value: number, mask: number): void {
    this.setEflags((this.getEflags() & ~mask) | (value & mask));
  }

  private setAdd(a: number, b: number, r: number, top: number): void {
    this.lazyOp = L_ADD;
    this.lazyA = a;
    this.lazyB = b;
    this.lazyR = r;
    this.lazyTop = top;
    this.lazyMask = ARITH_FLAGS;
  }

  private setSub(a: number, b: number, r: number, top: number): void {
    this.lazyOp = L_SUB;
    this.lazyA = a;
    this.lazyB = b;
    this.lazyR = r;
    this.lazyTop = top;
    this.lazyMask = ARITH_FLAGS;
  }

  private setLogic(r: number, top: number): void {
    this.lazyOp = L_LOGIC;
    this.lazyR = r;
    this.lazyTop = top;
    this.lazyMask = ARITH_FLAGS;
  }

  /** SF, ZF and PF from a result; CF, OF and AF as given. */
  private setResultFlags(r: number, top: number, cf: number, of: boolean, af = false): void {
    this.lazyOp = L_LOGIC;
    this.lazyR = r;
    this.lazyTop = top;
    this.lazyMask = SF | ZF | PF;
    this.flags = (this.flags & ~(CF | OF | AF)) | cf | (of ? OF : 0) | (af ? AF : 0);
  }

  private setFlag(flag: number, on: boolean): void {
    this.lazyMask &= ~flag;
    if (on) this.flags |= flag;
    else this.flags &= ~flag;
  }

  private cond(c: number): boolean {
    switch (c >> 1) {
      case 0:
        return this.of() !== !!(c & 1);
      case 1:
        return (this.cf() !== 0) !== !!(c & 1);
      case 2:
        return this.zf() !== !!(c & 1);
      case 3:
        return (this.cf() !== 0 || this.zf()) !== !!(c & 1);
      case 4:
        return this.sf() !== !!(c & 1);
      case 5:
        return this.pf() !== !!(c & 1);
      case 6:
        return (this.sf() !== this.of()) !== !!(c & 1);
      default:
        return (this.zf() || this.sf() !== this.of()) !== !!(c & 1);
    }
  }

  private get iopl(): number {
    return (this.flags >> 12) & 3;
  }

  // --- Registers -----------------------------------------------------------------------

  private getReg8(r: number): number {
    return r < 4 ? this.regs[r] & 0xff : (this.regs[r - 4] >> 8) & 0xff;
  }

  private setReg8(r: number, v: number): void {
    if (r < 4) this.regs[r] = (this.regs[r] & ~0xff) | (v & 0xff);
    else this.regs[r - 4] = (this.regs[r - 4] & ~0xff00) | ((v & 0xff) << 8);
  }

  private setReg16(r: number, v: number): void {
    this.regs[r] = (this.regs[r] & ~0xffff) | (v & 0xffff);
  }

  /** Writes a 16 or 32 bit result by the operand size. */
  private setRegV(r: number, v: number): void {
    if (this.o32) this.regs[r] = v;
    else this.regs[r] = (this.regs[r] & ~0xffff) | (v & 0xffff);
  }

  private getRegV(r: number): number {
    return this.o32 ? this.regs[r] : this.regs[r] & 0xffff;
  }

  // --- Exceptions ----------------------------------------------------------------------

  private raise(vector: number, code = -1): never {
    this.faultVector = vector;
    this.faultCode = code;
    throw FAULT;
  }

  private gp(code: number): never {
    this.raise(GP, code);
  }

  private ud(): never {
    this.raise(UD);
  }

  private segFault(seg: number): never {
    if (seg === SS) this.raise(SS_FAULT, 0);
    this.raise(GP, 0);
  }

  // --- Paging ----------------------------------------------------------------------------

  flushTlb(): void {
    if (this.tlbCount > TLB_TRACK) this.tlb.fill(0);
    else for (let i = 0; i < this.tlbCount; i++) this.tlb[this.tlbPages[i]] = 0;
    this.tlbCount = 0;
    this.fetchPage = -1;
  }

  private physRead32(addr: number): number {
    addr = (addr & this.a20Mask) >>> 0;
    if (addr + 3 < this.ram.length) {
      if (!(addr & 3)) return this.ram32[addr >> 2];
      return this.ram[addr] | (this.ram[addr + 1] << 8) | (this.ram[addr + 2] << 16) | (this.ram[addr + 3] << 24);
    }
    return 0;
  }

  private physWrite32(addr: number, v: number): void {
    addr = (addr & this.a20Mask) >>> 0;
    if (addr + 3 < this.ram.length && !(addr & 3)) {
      if (this.journal !== null) this.journalWrite(addr, 4);
      this.ram32[addr >> 2] = v;
      if (this.codePages[addr >>> 12] !== 0) this.codeWrite(addr, 4);
    }
  }

  /** Looks up a linear address (walking the page tables when paging), fills its TLB entry and returns it. */
  private translate(lin: number, write: boolean, user: boolean): number {
    let phys: number;
    let perms: number;
    if (!(this.cr0 & CR0_PG)) {
      phys = lin & PAGE_MASK & this.a20Mask;
      perms = T_SREAD | T_UREAD | T_SWRITE | T_UWRITE;
    } else {
      const pdeAddr = (this.cr3 & PAGE_MASK) + ((lin >>> 22) << 2);
      const pde = this.physRead32(pdeAddr);
      if (!(pde & 1)) this.pageFault(lin, write, user, false);
      let allowUser: boolean;
      let allowWrite: boolean;
      let dirty: boolean;
      if (pde & 0x80 && this.cr4 & CR4_PSE) {
        allowUser = (pde & 4) !== 0;
        allowWrite = (pde & 2) !== 0;
        if ((user && !allowUser) || (write && !allowWrite && (user || this.cr0 & CR0_WP))) this.pageFault(lin, write, user, true);
        if (!(pde & 0x20) || (write && !(pde & 0x40))) this.physWrite32(pdeAddr, pde | 0x20 | (write ? 0x40 : 0));
        dirty = write || (pde & 0x40) !== 0;
        phys = (pde & 0xffc00000) | (lin & 0x3ff000);
      } else {
        const pteAddr = (pde & PAGE_MASK) + (((lin >>> 12) & 0x3ff) << 2);
        const pte = this.physRead32(pteAddr);
        if (!(pte & 1)) this.pageFault(lin, write, user, false);
        allowUser = (pde & pte & 4) !== 0;
        allowWrite = (pde & pte & 2) !== 0;
        if ((user && !allowUser) || (write && !allowWrite && (user || this.cr0 & CR0_WP))) this.pageFault(lin, write, user, true);
        if (!(pde & 0x20)) this.physWrite32(pdeAddr, pde | 0x20);
        if (!(pte & 0x20) || (write && !(pte & 0x40))) this.physWrite32(pteAddr, pte | 0x20 | (write ? 0x40 : 0));
        dirty = write || (pte & 0x40) !== 0;
        phys = pte & PAGE_MASK;
      }
      phys &= this.a20Mask;
      perms = T_SREAD | (allowUser ? T_UREAD : 0);
      if (dirty) {
        if (allowWrite || !(this.cr0 & CR0_WP)) perms |= T_SWRITE;
        if (allowWrite && allowUser) perms |= T_UWRITE;
      }
    }
    const direct = this.host.directPage(phys >>> 0);
    const entry = direct >= 0 ? direct | perms | T_RAM : phys | perms;
    const page = lin >>> 12;
    if (this.tlb[page] === 0) {
      if (this.tlbCount < TLB_TRACK) this.tlbPages[this.tlbCount] = page;
      this.tlbCount++;
    }
    this.tlb[page] = entry;
    return entry;
  }

  private pageFault(lin: number, write: boolean, user: boolean, present: boolean): never {
    this.cr2 = lin >>> 0;
    this.raise(PAGE_FAULT, (present ? 1 : 0) | (write ? 2 : 0) | (user ? 4 : 0));
  }

  /** The TLB entry for reading `lin`, translating if it doesn't allow the access yet. */
  private readEntry(lin: number, user: boolean): number {
    const need = user ? T_UREAD : T_SREAD;
    const e = this.tlb[lin >>> 12];
    return (e & need) === need ? e : this.translate(lin, false, user);
  }

  private writeEntry(lin: number, user: boolean): number {
    const need = user ? T_UWRITE : T_SWRITE;
    const e = this.tlb[lin >>> 12];
    return (e & need) === need ? e : this.translate(lin, true, user);
  }

  // --- Linear memory ---------------------------------------------------------------------

  private rb(lin: number, user: boolean): number {
    const e = this.tlb[lin >>> 12];
    const need = user ? T_RAM | T_UREAD : T_RAM | T_SREAD;
    if ((e & need) === need) return this.ram[(e & PAGE_MASK) | (lin & 0xfff)];
    const entry = this.readEntry(lin, user);
    const p = ((entry & PAGE_MASK) | (lin & 0xfff)) >>> 0;
    return entry & T_RAM ? this.ram[p] : this.host.readMemory8(p);
  }

  private rw(lin: number, user: boolean): number {
    const e = this.tlb[lin >>> 12];
    const need = user ? T_RAM | T_UREAD : T_RAM | T_SREAD;
    if ((e & need) === need && (lin & 0xfff) !== 0xfff) {
      const p = (e & PAGE_MASK) | (lin & 0xfff);
      return this.ram[p] | (this.ram[p + 1] << 8);
    }
    if ((lin & 0xfff) === 0xfff) {
      this.readEntry((lin + 1) | 0, user);
      return this.rb(lin, user) | (this.rb((lin + 1) | 0, user) << 8);
    }
    const entry = this.readEntry(lin, user);
    const p = ((entry & PAGE_MASK) | (lin & 0xfff)) >>> 0;
    if (entry & T_RAM) return this.ram[p] | (this.ram[p + 1] << 8);
    return this.host.readMemory8(p) | (this.host.readMemory8(p + 1) << 8);
  }

  private rd(lin: number, user: boolean): number {
    const e = this.tlb[lin >>> 12];
    const need = user ? T_RAM | T_UREAD : T_RAM | T_SREAD;
    const off = lin & 0xfff;
    if ((e & need) === need && off <= 0xffc) {
      const p = (e & PAGE_MASK) | off;
      if (!(p & 3)) return this.ram32[p >> 2];
      const ram = this.ram;
      return ram[p] | (ram[p + 1] << 8) | (ram[p + 2] << 16) | (ram[p + 3] << 24);
    }
    if (off > 0xffc) {
      this.readEntry((lin + 4) | 0, user);
      return this.rb(lin, user) | (this.rb((lin + 1) | 0, user) << 8) | (this.rb((lin + 2) | 0, user) << 16) | (this.rb((lin + 3) | 0, user) << 24);
    }
    const entry = this.readEntry(lin, user);
    const p = ((entry & PAGE_MASK) | off) >>> 0;
    if (entry & T_RAM) return this.ram[p] | (this.ram[p + 1] << 8) | (this.ram[p + 2] << 16) | (this.ram[p + 3] << 24);
    const h = this.host;
    return h.readMemory8(p) | (h.readMemory8(p + 1) << 8) | (h.readMemory8(p + 2) << 16) | (h.readMemory8(p + 3) << 24);
  }

  private wb(lin: number, v: number, user: boolean): void {
    const e = this.tlb[lin >>> 12];
    const need = user ? T_RAM | T_UWRITE : T_RAM | T_SWRITE;
    if ((e & need) === need) {
      const p = (e & PAGE_MASK) | (lin & 0xfff);
      if (this.journal !== null) this.journalWrite(p, 1);
      this.ram[p] = v;
      if (this.codePages[p >>> 12] !== 0) this.codeWrite(p);
      return;
    }
    const entry = this.writeEntry(lin, user);
    const p = ((entry & PAGE_MASK) | (lin & 0xfff)) >>> 0;
    if (entry & T_RAM) {
      if (this.journal !== null) this.journalWrite(p, 1);
      this.ram[p] = v;
      if (this.codePages[p >>> 12] !== 0) this.codeWrite(p);
    } else {
      this.host.writeMemory8(p, v & 0xff);
    }
  }

  private ww(lin: number, v: number, user: boolean): void {
    const e = this.tlb[lin >>> 12];
    const need = user ? T_RAM | T_UWRITE : T_RAM | T_SWRITE;
    if ((e & need) === need && (lin & 0xfff) !== 0xfff) {
      const p = (e & PAGE_MASK) | (lin & 0xfff);
      if (this.journal !== null) this.journalWrite(p, 2);
      this.ram[p] = v;
      this.ram[p + 1] = v >> 8;
      if (this.codePages[p >>> 12] !== 0) this.codeWrite(p, 2);
      return;
    }
    if ((lin & 0xfff) === 0xfff) {
      this.writeEntry(lin, user);
      this.writeEntry((lin + 1) | 0, user);
      this.wb(lin, v, user);
      this.wb((lin + 1) | 0, v >> 8, user);
      return;
    }
    const entry = this.writeEntry(lin, user);
    const p = ((entry & PAGE_MASK) | (lin & 0xfff)) >>> 0;
    if (entry & T_RAM) {
      if (this.journal !== null) this.journalWrite(p, 2);
      this.ram[p] = v;
      this.ram[p + 1] = v >> 8;
      if (this.codePages[p >>> 12] !== 0) this.codeWrite(p, 2);
    } else {
      this.host.writeMemory8(p, v & 0xff);
      this.host.writeMemory8(p + 1, (v >> 8) & 0xff);
    }
  }

  private wd(lin: number, v: number, user: boolean): void {
    const e = this.tlb[lin >>> 12];
    const need = user ? T_RAM | T_UWRITE : T_RAM | T_SWRITE;
    const off = lin & 0xfff;
    if ((e & need) === need && off <= 0xffc) {
      const p = (e & PAGE_MASK) | off;
      if (this.codePages[p >>> 12] !== 0) this.codeWrite(p, 4);
      if (this.journal !== null) this.journalWrite(p, 4);
      if (!(p & 3)) {
        this.ram32[p >> 2] = v;
        return;
      }
      const ram = this.ram;
      ram[p] = v;
      ram[p + 1] = v >> 8;
      ram[p + 2] = v >> 16;
      ram[p + 3] = v >> 24;
      return;
    }
    if (off > 0xffc) {
      this.writeEntry(lin, user);
      this.writeEntry((lin + 3) | 0, user);
      for (let i = 0; i < 4; i++) this.wb((lin + i) | 0, v >> (i * 8), user);
      return;
    }
    const entry = this.writeEntry(lin, user);
    const p = ((entry & PAGE_MASK) | off) >>> 0;
    if (entry & T_RAM) {
      if (this.codePages[p >>> 12] !== 0) this.codeWrite(p, 4);
      if (this.journal !== null) this.journalWrite(p, 4);
      const ram = this.ram;
      ram[p] = v;
      ram[p + 1] = v >> 8;
      ram[p + 2] = v >> 16;
      ram[p + 3] = v >> 24;
    } else {
      for (let i = 0; i < 4; i++) this.host.writeMemory8(p + i, (v >> (i * 8)) & 0xff);
    }
  }

  /** Makes sure a write of `size` bytes at `lin` won't fault, before an instruction changes anything. */
  private checkWrite(lin: number, size: number): void {
    this.writeEntry(lin, this.user);
    const end = (lin + size - 1) | 0;
    if ((end ^ lin) & PAGE_MASK) this.writeEntry(end, this.user);
  }

  // System structures (descriptor tables, the TSS) are read and written with supervisor rights.
  private sysRead16(lin: number): number {
    return this.rw(lin | 0, false);
  }
  private sysRead32(lin: number): number {
    return this.rd(lin | 0, false);
  }
  private sysWrite16(lin: number, v: number): void {
    this.ww(lin | 0, v, false);
  }
  private sysWrite32(lin: number, v: number): void {
    this.wd(lin | 0, v, false);
  }

  // --- Segmented memory ------------------------------------------------------------------

  read8(seg: number, off: number): number {
    if (off < this.rLow[seg] || off > this.rHigh[seg]) this.segFault(seg);
    return this.rb((this.segBase[seg] + off) | 0, this.user);
  }

  read16(seg: number, off: number): number {
    if (off < this.rLow[seg] || off > this.rHigh[seg] - 1) this.segFault(seg);
    return this.rw((this.segBase[seg] + off) | 0, this.user);
  }

  read32(seg: number, off: number): number {
    if (off < this.rLow[seg] || off > this.rHigh[seg] - 3) this.segFault(seg);
    return this.rd((this.segBase[seg] + off) | 0, this.user);
  }

  write8(seg: number, off: number, v: number): void {
    if (off < this.wLow[seg] || off > this.wHigh[seg]) this.segFault(seg);
    this.wb((this.segBase[seg] + off) | 0, v, this.user);
  }

  write16(seg: number, off: number, v: number): void {
    if (off < this.wLow[seg] || off > this.wHigh[seg] - 1) this.segFault(seg);
    this.ww((this.segBase[seg] + off) | 0, v, this.user);
  }

  write32(seg: number, off: number, v: number): void {
    if (off < this.wLow[seg] || off > this.wHigh[seg] - 3) this.segFault(seg);
    this.wd((this.segBase[seg] + off) | 0, v, this.user);
  }

  /** Checks a later write of `size` bytes at seg:off can't fault. */
  private checkWriteSeg(seg: number, off: number, size: number): void {
    if (off < this.wLow[seg] || off > this.wHigh[seg] - (size - 1)) this.segFault(seg);
    this.checkWrite((this.segBase[seg] + off) | 0, size);
  }

  // The FPU's memory operand: where the instruction's ModR/M byte points.
  fpuRead16(offset = 0): number {
    return this.read16(this.eaSeg, this.eaOffset(offset));
  }
  fpuRead32(offset = 0): number {
    return this.read32(this.eaSeg, this.eaOffset(offset));
  }
  fpuWrite16(v: number, offset = 0): void {
    this.write16(this.eaSeg, this.eaOffset(offset), v);
  }
  fpuWrite32(v: number, offset = 0): void {
    this.write32(this.eaSeg, this.eaOffset(offset), v);
  }
  fpuRead8(offset = 0): number {
    return this.read8(this.eaSeg, this.eaOffset(offset));
  }
  fpuWrite8(v: number, offset = 0): void {
    this.write8(this.eaSeg, this.eaOffset(offset), v);
  }
  /** Checks the FPU can store `size` bytes at its memory operand. */
  fpuCheckWrite(size: number): void {
    this.checkWriteSeg(this.eaSeg, this.ea, size);
  }
  get fpuOperandSize32(): boolean {
    return this.o32;
  }
  get fpuRealMode(): boolean {
    return !(this.cr0 & CR0_PE) || (this.flags & VM) !== 0;
  }
  get fpuAx(): number {
    return this.regs[EAX] & 0xffff;
  }
  set fpuAx(v: number) {
    this.setReg16(EAX, v);
  }
  /** An unmasked x87 exception is pending as the FPU starts an instruction or FWAIT runs. */
  fpuException(): void {
    if (this.cr0 & CR0_NE) this.raise(16);
    this.host.fpuError();
  }

  private eaOffset(add: number): number {
    return this.a32 ? (this.ea + add) >>> 0 : (this.ea + add) & 0xffff;
  }

  // --- Stack -------------------------------------------------------------------------------

  private get sp(): number {
    return this.stack32 ? this.regs[ESP] >>> 0 : this.regs[ESP] & 0xffff;
  }

  private setSp(v: number): void {
    if (this.stack32) this.regs[ESP] = v;
    else this.regs[ESP] = (this.regs[ESP] & ~0xffff) | (v & 0xffff);
  }

  private stackAddr(sp: number): number {
    return this.stack32 ? sp >>> 0 : sp & 0xffff;
  }

  private push16(v: number): void {
    const sp = this.stackAddr(this.regs[ESP] - 2);
    this.write16(SS, sp, v);
    this.setSp(sp);
  }

  private push32(v: number): void {
    const sp = this.stackAddr(this.regs[ESP] - 4);
    this.write32(SS, sp, v);
    this.setSp(sp);
  }

  private pushV(v: number): void {
    if (this.o32) this.push32(v);
    else this.push16(v);
  }

  private pop16(): number {
    const sp = this.sp;
    const v = this.read16(SS, sp);
    this.setSp(sp + 2);
    return v;
  }

  private pop32(): number {
    const sp = this.sp;
    const v = this.peek(0, 4);
    this.setSp(sp + 4);
    return v;
  }

  private popV(): number {
    return this.o32 ? this.pop32() : this.pop16();
  }

  /** Reads the stack `offset` bytes above the stack pointer, without popping. */
  private peek(offset: number, size: number): number {
    const at = this.stackAddr(this.sp + offset);
    return size === 4 ? this.read32(SS, at) : this.read16(SS, at);
  }

  // --- Instruction fetch ---------------------------------------------------------------

  /** Points `fp` at the instruction's first byte in RAM when its page is cached, for fetch8's fast path. */
  private startFetch(): void {
    const lin = (this.csBase + this.eip) | 0;
    if ((lin & PAGE_MASK) === this.fetchPage) {
      this.fp = this.fetchPhys | (lin & 0xfff);
      this.fpEnd = this.fetchPhys + 0x1000;
    } else {
      this.fp = this.fpEnd = 0;
    }
  }

  private fetch8(): number {
    const p = this.fp;
    if (p < this.fpEnd) {
      this.fp = p + 1;
      this.eip = (this.eip + 1) | 0;
      return this.ram[p];
    }
    return this.fetchByte();
  }

  private fetchByte(): number {
    const lin = (this.csBase + this.eip) | 0;
    let b: number;
    if ((lin & PAGE_MASK) === this.fetchPage) b = this.ram[this.fetchPhys | (lin & 0xfff)];
    else b = this.fetchSlow(lin);
    this.eip = (this.eip + 1) | 0;
    this.startFetch();
    return b;
  }

  /**
   * Fetches outside the cached page: checks the CS limit (IP doesn't wrap at 64K, it faults past
   * the limit) and caches the page when all of it is inside the limit and plain RAM.
   */
  private fetchSlow(lin: number): number {
    const limit = this.segLimit[CS];
    if (this.eip >>> 0 > limit) this.gp(0);
    const entry = this.readEntry(lin, this.user);
    const p = ((entry & PAGE_MASK) | (lin & 0xfff)) >>> 0;
    if (entry & T_RAM) {
      const pageOffset = ((lin & PAGE_MASK) - this.csBase) >>> 0;
      if (pageOffset <= limit && pageOffset + 0xfff <= limit) {
        this.fetchPage = lin & PAGE_MASK;
        this.fetchPhys = entry & PAGE_MASK;
      }
      return this.ram[p];
    }
    return this.host.readMemory8(p);
  }

  private fetch16(): number {
    return this.fetch8() | (this.fetch8() << 8);
  }

  private fetch32(): number {
    const p = this.fp;
    if (p + 4 <= this.fpEnd) {
      const ram = this.ram;
      this.fp = p + 4;
      this.eip = (this.eip + 4) | 0;
      return ram[p] | (ram[p + 1] << 8) | (ram[p + 2] << 16) | (ram[p + 3] << 24);
    }
    return this.fetch8() | (this.fetch8() << 8) | (this.fetch8() << 16) | (this.fetch8() << 24);
  }

  private fetchImmV(): number {
    return this.o32 ? this.fetch32() : this.fetch16();
  }

  // --- Segments ------------------------------------------------------------------------

  private setCpl(cpl: number): void {
    this.cpl = cpl;
    this.user = cpl === 3;
    this.fetchPage = -1;
  }

  /** Fills a segment register's cache and works out the offsets it allows. */
  private setSegCache(seg: number, selector: number, base: number, limit: number, attr: number): void {
    this.sel[seg] = selector & 0xffff;
    this.segBase[seg] = base >>> 0;
    this.segLimit[seg] = limit >>> 0;
    this.segAttr[seg] = attr;
    this.updateWindows(seg);
    if (seg === CS) {
      this.csBase = base | 0;
      this.code32 = (attr & SEG_BIG) !== 0;
      this.fetchPage = -1;
    } else if (seg === SS) {
      this.stack32 = (attr & SEG_BIG) !== 0;
    }
  }

  private updateWindows(seg: number): void {
    const attr = this.segAttr[seg];
    const limit = this.segLimit[seg];
    let rLow = 0;
    let rHigh = limit;
    let wLow = 0;
    let wHigh = limit;
    const usable = (attr & 0x80) !== 0 && (attr & 0x10) !== 0;
    if (!usable) {
      rLow = wLow = 1;
      rHigh = wHigh = 0;
    } else if (attr & 0x08) {
      // Code: readable or execute-only, never writable (except in real mode, where the cache says data).
      if (!(attr & 0x02)) {
        rLow = 1;
        rHigh = 0;
      }
      wLow = 1;
      wHigh = 0;
    } else {
      if (attr & 0x04) {
        // Expand-down: the offsets above the limit.
        rLow = wLow = limit + 1;
        rHigh = wHigh = attr & SEG_BIG ? 0xffffffff : 0xffff;
      }
      if (!(attr & 0x02)) {
        wLow = 1;
        wHigh = 0;
      }
    }
    this.rLow[seg] = rLow;
    this.rHigh[seg] = rHigh;
    this.wLow[seg] = wLow;
    this.wHigh[seg] = wHigh;
  }

  /** A segment load in real mode (the cached limit and attributes stay) or virtual 8086 mode (64K, ring 3). */
  private loadSegReal(seg: number, selector: number): void {
    selector &= 0xffff;
    if (this.flags & VM) {
      this.setSegCache(seg, selector, selector << 4, 0xffff, 0xf3);
      return;
    }
    this.sel[seg] = selector;
    this.segBase[seg] = selector << 4;
    if (seg === CS) {
      this.csBase = selector << 4;
      this.fetchPage = -1;
    }
    this.makeRealModeAccessible(seg);
  }

  /** Real mode checks only limits: whatever type the cache held (from protected mode), the segment can be read and written. */
  private makeRealModeAccessible(seg: number): void {
    const attr = this.segAttr[seg];
    if ((attr & 0x9e) === 0x92) return;
    this.segAttr[seg] = 0x93 | (attr & (SEG_BIG | 0x8000));
    this.updateWindows(seg);
  }

  /** Reads the descriptor `selector` picks into descLo/descHi; false if it's beyond its table. */
  private readDescriptor(selector: number): boolean {
    const index = selector & 0xfff8;
    let addr: number;
    if (selector & 4) {
      if ((this.ldtSel & 0xfffc) === 0 || index + 7 > this.ldtLimit) return false;
      addr = this.ldtBase + index;
    } else {
      if (index + 7 > this.gdtLimit) return false;
      addr = this.gdtBase + index;
    }
    this.descAddr = addr;
    this.descLo = this.sysRead32(addr);
    this.descHi = this.sysRead32(addr + 4);
    return true;
  }

  private descBase(): number {
    return ((this.descLo >>> 16) | ((this.descHi & 0xff) << 16) | (this.descHi & 0xff000000)) >>> 0;
  }

  private descLimit(): number {
    const limit = (this.descLo & 0xffff) | (this.descHi & 0xf0000);
    return this.descHi & 0x800000 ? ((limit << 12) | 0xfff) >>> 0 : limit;
  }

  private descAttr(): number {
    return (this.descHi >>> 8) & 0xf0ff;
  }

  /** Sets the accessed bit of the descriptor just read. */
  private markAccessed(): void {
    if (!(this.descHi & 0x100)) {
      this.descHi |= 0x100;
      this.sysWrite32(this.descAddr + 4, this.descHi);
    }
  }

  private loadSeg(seg: number, selector: number): void {
    if (!(this.cr0 & CR0_PE) || this.flags & VM) this.loadSegReal(seg, selector);
    else this.loadSegProtected(seg, selector);
  }

  private loadSegProtected(seg: number, selector: number): void {
    selector &= 0xffff;
    if ((selector & 0xfffc) === 0) {
      if (seg === SS) this.gp(0);
      this.setSegCache(seg, selector, 0, 0, 0);
      return;
    }
    if (!this.readDescriptor(selector)) this.gp(selector & 0xfffc);
    const attr = this.descAttr();
    const dpl = (attr >> 5) & 3;
    const rpl = selector & 3;
    const isCode = (attr & 0x18) === 0x18;
    const isData = (attr & 0x18) === 0x10;
    if (seg === SS) {
      if (rpl !== this.cpl || dpl !== this.cpl || !isData || !(attr & 2)) this.gp(selector & 0xfffc);
      if (!(attr & 0x80)) this.raise(SS_FAULT, selector & 0xfffc);
    } else {
      if (!isData && !(isCode && attr & 2)) this.gp(selector & 0xfffc);
      if ((isData || !(attr & 4)) && (rpl > dpl || this.cpl > dpl)) this.gp(selector & 0xfffc);
      if (!(attr & 0x80)) this.raise(NP, selector & 0xfffc);
    }
    this.markAccessed();
    this.setSegCache(seg, selector, this.descBase(), this.descLimit(), this.descAttr());
  }

  /** Loads CS from the descriptor just read, at privilege `cpl`. */
  private loadCs(selector: number, cpl: number): void {
    this.markAccessed();
    this.setSegCache(CS, (selector & 0xfffc) | cpl, this.descBase(), this.descLimit(), this.descAttr());
    this.setCpl(cpl);
  }

  /** After a return to an outer ring: data segments the new ring may not use become null. */
  private nullInaccessibleSegments(): void {
    for (const seg of [ES, DS, FS, GS]) {
      const attr = this.segAttr[seg];
      const dpl = (attr >> 5) & 3;
      const conformingCode = (attr & 0x1c) === 0x1c;
      if ((this.sel[seg] & 0xfffc) !== 0 && !conformingCode && dpl < this.cpl) this.setSegCache(seg, 0, 0, 0, 0);
      else if ((this.sel[seg] & 0xfffc) === 0) this.setSegCache(seg, this.sel[seg], 0, 0, 0);
    }
  }

  /** Validates a stack segment for ring `cpl` (from a TSS, gate or return); faults with `vector`. */
  private checkStackSeg(selector: number, cpl: number, vector: number): void {
    if ((selector & 0xfffc) === 0) this.raise(vector, 0);
    if (!this.readDescriptor(selector)) this.raise(vector, selector & 0xfffc);
    const attr = this.descAttr();
    if ((selector & 3) !== cpl || ((attr >> 5) & 3) !== cpl || (attr & 0x1a) !== 0x12) this.raise(vector, selector & 0xfffc);
    if (!(attr & 0x80)) this.raise(SS_FAULT, selector & 0xfffc);
  }

  // --- Running -------------------------------------------------------------------------

  /** Runs up to `limit` instructions; returns early when the CPU halts. */
  run(limit: number): void {
    this.budget = limit;
    while (this.budget > 0) {
      if (this.halted) {
        if (!(this.irqLine && this.flags & IF)) return;
        this.halted = false;
      }
      try {
        this.runSlice();
      } catch (error) {
        if (error !== FAULT) throw error;
        this.budget--;
        this.cycles++;
        this.eip = this.startEip;
        this.regs[ESP] = this.startEsp;
        this.deliverException(this.faultVector, this.faultCode);
      }
    }
  }

  private runSlice(): void {
    while (this.budget > 0) {
      if (this.irqLine && this.flags & IF && !this.inhibit) {
        this.startEip = this.eip;
        this.startEsp = this.regs[ESP];
        const vector = this.host.acknowledgeInterrupt();
        if (vector >= 0) this.interrupt(vector, INT_EXTERNAL, -1);
      }
      this.inhibit = false;
      const trap = this.flags & TF;
      if (!trap && this.jitEnabled) {
        const block = this.findBlock();
        if (block !== null) {
          if (this.jitCheck !== null) {
            this.runChecked(block);
          } else {
            this.budget -= block.count;
            this.cycles += block.count;
            this.jitDirty = false;
            block.fn(this, this.regs);
          }
          if (this.halted) return;
          continue;
        }
      }
      this.step();
      this.budget--;
      this.cycles++;
      if (trap) {
        this.dr[6] |= 0x4000;
        this.startEip = this.eip;
        this.startEsp = this.regs[ESP];
        this.interrupt(DB, INT_EXCEPTION, -1);
      }
      if (this.halted) return;
    }
  }

  // --- Translated blocks ---------------------------------------------------------------

  /** The translated block starting at the instruction pointer, translating it once it has run often enough. */
  private findBlock(): Block | null {
    const lin = (this.csBase + this.eip) | 0;
    if ((lin & PAGE_MASK) !== this.fetchPage && !this.cacheFetchPage(lin)) return null;
    const phys = this.fetchPhys | (lin & 0xfff);
    const key = this.code32 ? phys * 2 + 1 : phys * 2;
    const keys = this.slotKey;
    let slot = Math.imul(key | 0, 0x9e3779b1) >>> SLOT_SHIFT;
    for (;;) {
      const k = keys[slot];
      if (k === key) break;
      if (k === -1) {
        if (this.slotsUsed > MAX_BLOCKS) {
          this.flushBlocks();
          return null;
        }
        keys[slot] = key;
        this.usedSlots[this.slotsUsed++] = slot;
        break;
      }
      slot = (slot + 1) & (BLOCK_SLOTS - 1);
    }
    const block = this.slotBlock[slot];
    if (block !== undefined) return block;
    if (++this.slotHits[slot] < this.jitThreshold) return null;
    const page = phys >>> 12;
    const compiled = (this.rewrites.get(page) ?? 0) < MAX_REWRITES ? compileBlock(this.ram, phys, this.code32) : null;
    this.slotBlock[slot] = compiled;
    const slots = this.pageSlots.get(page);
    if (slots) slots.push(slot);
    else this.pageSlots.set(page, [slot]);
    // A block that wasn't translated still watches its first byte, so the guess is revisited if the code changes.
    const end = phys + (compiled ? compiled.length : 1);
    for (let i = phys; i < end; i++) this.codeBits[i >>> 5] |= 1 << (i & 31);
    this.codePages[page] = 1;
    return compiled;
  }

  /**
   * Makes `lin`'s page the cached fetch page if it's RAM inside the CS limit, without faulting: with
   * paging on, only when the TLB already has the page (a fault here would come before the instruction starts).
   */
  private cacheFetchPage(lin: number): boolean {
    const need = this.user ? T_RAM | T_UREAD : T_RAM | T_SREAD;
    let e = this.tlb[lin >>> 12];
    if ((e & need) !== need) {
      if (this.cr0 & CR0_PG) return false;
      e = this.translate(lin, false, this.user);
      if ((e & need) !== need) return false;
    }
    const limit = this.segLimit[CS];
    const pageOffset = ((lin & PAGE_MASK) - this.csBase) >>> 0;
    if (pageOffset > limit || pageOffset + 0xfff > limit) return false;
    this.fetchPage = lin & PAGE_MASK;
    this.fetchPhys = e & PAGE_MASK;
    return true;
  }

  /** A write of `size` bytes at `index` in a page with translated code: if it reaches code, the page's blocks go. */
  private codeWrite(index: number, size = 1): void {
    const bits = this.codeBits;
    let hit = 0;
    for (let i = index; i < index + size; i++) hit |= bits[i >>> 5] & (1 << (i & 31));
    if (!hit) return;
    const page = index >>> 12;
    const slots = this.pageSlots.get(page);
    if (slots) {
      for (const slot of slots) {
        this.slotBlock[slot] = undefined;
        this.slotHits[slot] = 0;
      }
      this.pageSlots.delete(page);
    }
    bits.fill(0, page << 7, (page + 1) << 7);
    this.codePages[page] = 0;
    this.rewrites.set(page, (this.rewrites.get(page) ?? 0) + 1);
    this.jitDirty = true;
  }

  // --- Checking translated blocks --------------------------------------------------------

  /**
   * Runs every translated block twice, translated and then interpreted from the same
   * start, and reports what differs; the interpreter's result is kept. Blocks that touch
   * devices (ports, device memory) or fault aren't checked. `null` stops checking.
   */
  checkJit(report: ((text: string) => void) | null): void {
    if (report && !this.jitCheck) {
      const host = this.host;
      const count = <T extends unknown[], R>(fn: (...args: T) => R) => (...args: T): R => {
        this.deviceAccesses++;
        return fn.apply(host, args);
      };
      this.host = Object.assign(Object.create(host) as CpuHost, {
        readMemory8: count(host.readMemory8),
        writeMemory8: count(host.writeMemory8),
        in8: count(host.in8),
        in16: count(host.in16),
        in32: count(host.in32),
        out8: count(host.out8),
        out16: count(host.out16),
        out32: count(host.out32),
      });
    } else if (!report && this.jitCheck) {
      this.host = Object.getPrototypeOf(this.host) as CpuHost;
    }
    this.jitCheck = report;
  }

  private journalWrite(index: number, size: number): void {
    for (let i = 0; i < size; i++) this.journal!.push(index + i, this.ram[index + i]);
  }

  private static readonly STATE_NAMES = [
    ...['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi', 'eip', 'eflags'],
    ...['es', 'cs', 'ss', 'ds', 'fs', 'gs'].flatMap((s) => [s, `${s}.base`, `${s}.limit`, `${s}.attr`]),
    ...['cpl', 'code32', 'stack32', 'cr0', 'cr2', 'cr3', 'cr4', 'halted', 'inhibit'],
  ];

  /** The state a block can change (besides memory), in the order of STATE_NAMES. */
  private checkState(): number[] {
    const state = [...this.regs, this.eip, this.getEflags()];
    for (let s = 0; s < 6; s++) state.push(this.sel[s], this.segBase[s], this.segLimit[s], this.segAttr[s]);
    state.push(this.cpl, +this.code32, +this.stack32, this.cr0, this.cr2, this.cr3, this.cr4, +this.halted, +this.inhibit);
    return state;
  }

  private saveForCheck() {
    return {
      state: this.checkState(),
      bounds: [this.rLow, this.rHigh, this.wLow, this.wHigh].map((a) => [...a]),
      csBase: this.csBase,
      user: this.user,
    };
  }

  private restoreForCheck(saved: ReturnType<Cpu['saveForCheck']>): void {
    const s = saved.state;
    this.regs.set(s.slice(0, 8));
    this.eip = s[8];
    this.setEflags(s[9]);
    for (let seg = 0; seg < 6; seg++) {
      [this.sel[seg], this.segBase[seg], this.segLimit[seg], this.segAttr[seg]] = s.slice(10 + seg * 4, 14 + seg * 4);
    }
    [this.rLow, this.rHigh, this.wLow, this.wHigh].forEach((a, i) => a.splice(0, 6, ...saved.bounds[i]));
    let at = 34;
    this.cpl = s[at++];
    this.code32 = s[at++] === 1;
    this.stack32 = s[at++] === 1;
    [this.cr0, this.cr2, this.cr3, this.cr4] = s.slice(at, at + 4);
    at += 4;
    this.halted = s[at++] === 1;
    this.inhibit = s[at++] === 1;
    this.csBase = saved.csBase;
    this.user = saved.user;
    // The page walks happen again, setting the accessed and dirty bits the undone writes cleared.
    this.flushTlb();
  }

  private runChecked(block: Block): void {
    const start = this.saveForCheck();
    const lin = (this.csBase + this.eip) >>> 0;
    const phys = this.fetchPhys | (lin & 0xfff);
    const devices = this.deviceAccesses;
    this.journal = [];
    this.budget -= block.count;
    this.cycles += block.count;
    this.jitDirty = false;
    // A fault ends the block where the exception handling (in `run`) restarts the faulting instruction.
    let translatedFault = -1;
    try {
      block.fn(this, this.regs);
    } catch (error) {
      if (error !== FAULT) throw error;
      translatedFault = this.faultVector;
      this.eip = this.startEip;
      this.regs[ESP] = this.startEsp;
    }
    const translatedWrites = this.journal;
    this.journal = null;
    if (this.deviceAccesses !== devices) {
      if (translatedFault >= 0) throw FAULT;
      return;
    }
    const translated = this.checkState();
    const translatedMemory = new Map<number, number>();
    for (let i = 0; i < translatedWrites.length; i += 2) translatedMemory.set(translatedWrites[i], this.ram[translatedWrites[i]]);
    for (let i = translatedWrites.length - 2; i >= 0; i -= 2) this.ram[translatedWrites[i]] = translatedWrites[i + 1];

    this.restoreForCheck(start);
    const original = new Map<number, number>();
    for (let i = 0; i < translatedWrites.length; i += 2) if (!original.has(translatedWrites[i])) original.set(translatedWrites[i], translatedWrites[i + 1]);
    this.journal = [];
    let steps = 0;
    const bytes = Array.from(this.ram.subarray(phys, phys + block.length), (b) => b.toString(16).padStart(2, '0')).join(' ');
    const where = `block at ${lin.toString(16)} (physical ${phys.toString(16)}, ${this.code32 ? 32 : 16}-bit, ${block.count} instructions): ${bytes}`;
    // A block may stop early, and may pass the address it stopped at more than once (a loop inside
    // it), so the interpreter runs until its state matches, for at most the block's instructions.
    const matches = () => this.checkState().every((value, i) => value === translated[i]);
    let interpretedFault = -1;
    try {
      while (steps < block.count && !this.halted && !(steps > 0 && translatedFault < 0 && matches())) {
        this.step();
        steps++;
      }
    } catch (error) {
      if (error !== FAULT) throw error;
      interpretedFault = this.faultVector;
      this.eip = this.startEip;
      this.regs[ESP] = this.startEsp;
    }
    const interpretedWrites = this.journal;
    this.journal = null;
    for (let i = 0; i < interpretedWrites.length; i += 2) if (!original.has(interpretedWrites[i])) original.set(interpretedWrites[i], interpretedWrites[i + 1]);

    const interpreted = this.checkState();
    const differences: string[] = [];
    if (interpretedFault !== translatedFault) {
      const describe = (vector: number) => (vector < 0 ? 'no fault' : `fault ${vector}`);
      differences.push(`translated ${describe(translatedFault)}, interpreted ${describe(interpretedFault)} after ${steps} instructions`);
    }
    const hex = (n: number) => (n >>> 0).toString(16);
    interpreted.forEach((value, i) => {
      if (value !== translated[i]) differences.push(`${Cpu.STATE_NAMES[i]} translated ${hex(translated[i])} interpreted ${hex(value)}`);
    });
    for (const [index, before] of original) {
      const t = translatedMemory.get(index) ?? before;
      const v = this.ram[index];
      if (t !== v) differences.push(`ram[${hex(index)}] translated ${hex(t)} interpreted ${hex(v)} (was ${hex(before)})`);
    }
    if (differences.length) {
      const startRegs = Cpu.STATE_NAMES.slice(0, 10).map((name, i) => `${name}=${hex(start.state[i])}`).join(' ');
      this.jitCheck?.(`${where}\n  from ${startRegs}\n  ${differences.join('\n  ')}`);
    }
    // The interpreter's fault (with its vector and code) is the one delivered.
    if (interpretedFault >= 0) throw FAULT;
  }

  /** A device wrote a byte of memory at `index` in `ram` (DMA). */
  memoryWritten(index: number): void {
    if (this.codePages[index >>> 12]) this.codeWrite(index);
  }

  /** Drops every block (only the slots and pages in use are cleared, so this is cheap when few are). */
  private flushBlocks(): void {
    for (let i = 0; i < this.slotsUsed; i++) {
      const slot = this.usedSlots[i];
      this.slotKey[slot] = -1;
      this.slotBlock[slot] = undefined;
      this.slotHits[slot] = 0;
    }
    this.slotsUsed = 0;
    for (const page of this.pageSlots.keys()) {
      this.codeBits.fill(0, page << 7, (page + 1) << 7);
      this.codePages[page] = 0;
    }
    this.pageSlots.clear();
    this.rewrites.clear();
  }

  /** Runs one instruction (for tests); exceptions it raises are delivered. */
  stepOne(): void {
    this.run(1);
  }

  /** Called with each exception as it is delivered (for debugging). */
  onException: ((vector: number, code: number) => void) | null = null;

  private deliverException(vector: number, code: number): void {
    this.onException?.(vector, code);
    const first = this.delivering;
    if (first === DOUBLE_FAULT) {
      this.delivering = -1;
      this.host.shutdown();
      return;
    }
    if (first >= 0 && ((CONTRIBUTORY.has(first) && CONTRIBUTORY.has(vector)) || (first === PAGE_FAULT && (vector === PAGE_FAULT || CONTRIBUTORY.has(vector))))) {
      vector = DOUBLE_FAULT;
      code = 0;
    }
    this.delivering = vector;
    try {
      this.interrupt(vector, INT_EXCEPTION, HAS_ERROR_CODE.has(vector) ? Math.max(code, 0) : -1);
      this.delivering = -1;
    } catch (error) {
      if (error !== FAULT) throw error;
      this.eip = this.startEip;
      this.regs[ESP] = this.startEsp;
      this.deliverException(this.faultVector, this.faultCode);
    }
  }

  // --- Interrupts ----------------------------------------------------------------------

  /** Delivers interrupt `vector`; `code` is the error code to push, or -1 for none. */
  private interrupt(vector: number, kind: number, code: number): void {
    this.halted = false;
    if (!(this.cr0 & CR0_PE)) {
      const at = vector << 2;
      if (at + 3 > this.idtLimit) this.gp(at | 2);
      const ip = this.sysRead16(this.idtBase + at);
      const cs = this.sysRead16(this.idtBase + at + 2);
      const flags = this.getEflags();
      this.push16(flags);
      this.push16(this.sel[CS]);
      this.push16(this.eip);
      this.flags &= ~(IF | TF | AC | RF);
      this.loadSegReal(CS, cs);
      this.eip = ip;
      return;
    }
    const ext = kind === INT_SOFT ? 0 : 1;
    const at = vector << 3;
    if (at + 7 > this.idtLimit) this.gp(at | 2 | ext);
    const lo = this.sysRead32(this.idtBase + at);
    const hi = this.sysRead32(this.idtBase + at + 4);
    const type = (hi >>> 8) & 0x1f;
    const gateDpl = (hi >>> 13) & 3;
    if (kind === INT_SOFT && gateDpl < this.cpl) this.gp(at | 2);
    if (type !== 5 && type !== 6 && type !== 7 && type !== 0xe && type !== 0xf) this.gp(at | 2 | ext);
    if (!(hi & 0x8000)) this.raise(NP, at | 2 | ext);
    if (type === 5) {
      this.taskSwitch(lo >>> 16, TASK_INT);
      if (code >= 0) {
        if (this.stack32) this.push32(code);
        else this.push16(code);
      }
      return;
    }
    const gate32 = (type & 8) !== 0;
    const trap = (type & 1) !== 0;
    const target = lo >>> 16;
    const offset = gate32 ? ((hi & 0xffff0000) | (lo & 0xffff)) >>> 0 : lo & 0xffff;
    if ((target & 0xfffc) === 0) this.gp(ext);
    if (!this.readDescriptor(target)) this.gp((target & 0xfffc) | ext);
    const attr = this.descAttr();
    const dpl = (attr >> 5) & 3;
    if ((attr & 0x18) !== 0x18 || dpl > this.cpl) this.gp((target & 0xfffc) | ext);
    if (!(attr & 0x80)) this.raise(NP, (target & 0xfffc) | ext);
    const csLo = this.descLo;
    const csHi = this.descHi;
    const csAddr = this.descAddr;
    const conforming = (attr & 4) !== 0;
    const newCpl = conforming ? this.cpl : dpl;
    const fromVm = (this.flags & VM) !== 0;
    if (fromVm && newCpl !== 0) this.gp(target & 0xfffc);
    const flags = this.getEflags();
    const size = gate32 ? 4 : 2;
    const frame: number[] = [];

    if (newCpl < this.cpl) {
      // To an inner ring, on the stack the TSS gives for it.
      const { ss, esp } = this.tssStack(newCpl);
      this.checkStackSeg(ss, newCpl, TS);
      const ssBase = this.descBase();
      const ssLimit = this.descLimit();
      const ssAttr = this.descAttr();
      const ssLo = this.descLo;
      const ssHi = this.descHi;
      const ssAddr = this.descAddr;
      if (fromVm) frame.push(this.sel[GS], this.sel[FS], this.sel[DS], this.sel[ES]);
      frame.push(this.sel[SS], this.regs[ESP], flags, this.sel[CS], this.eip);
      if (code >= 0) frame.push(code);
      const big = (ssAttr & SEG_BIG) !== 0;
      let sp = esp;
      for (const value of frame) {
        sp = big ? (sp - size) >>> 0 : (sp - size) & 0xffff;
        if (sp > ssLimit - (size - 1)) this.raise(SS_FAULT, ss & 0xfffc);
        if (size === 4) this.sysWrite32(ssBase + sp, value);
        else this.sysWrite16(ssBase + sp, value);
      }
      this.descLo = ssLo;
      this.descHi = ssHi;
      this.descAddr = ssAddr;
      this.markAccessed();
      this.setSegCache(SS, ss, ssBase, ssLimit, ssAttr);
      this.regs[ESP] = big ? sp : (esp & ~0xffff) | sp;
      if (fromVm) for (const seg of [ES, DS, FS, GS]) this.setSegCache(seg, 0, 0, 0, 0);
    } else {
      frame.push(flags, this.sel[CS], this.eip);
      if (code >= 0) frame.push(code);
      for (const value of frame) {
        if (size === 4) this.push32(value);
        else this.push16(value);
      }
    }
    this.descLo = csLo;
    this.descHi = csHi;
    this.descAddr = csAddr;
    this.flags &= ~(TF | NT | RF | VM);
    if (!trap) this.flags &= ~IF;
    this.loadCs(target, newCpl);
    this.eip = offset | 0;
  }

  /** The stack for ring `cpl` from the current TSS. */
  private tssStack(cpl: number): { ss: number; esp: number } {
    if (this.trType & 8) {
      const at = 4 + cpl * 8;
      if (at + 5 > this.trLimit) this.raise(TS, this.trSel & 0xfffc);
      return { esp: this.sysRead32(this.trBase + at), ss: this.sysRead16(this.trBase + at + 4) };
    }
    const at = 2 + cpl * 4;
    if (at + 3 > this.trLimit) this.raise(TS, this.trSel & 0xfffc);
    return { esp: this.sysRead16(this.trBase + at), ss: this.sysRead16(this.trBase + at + 2) };
  }

  private softwareInterrupt(vector: number): void {
    if (this.flags & VM && this.iopl < 3) this.gp(0);
    this.interrupt(vector, INT_SOFT, -1);
  }

  private iret(): void {
    const o32 = this.o32;
    const size = o32 ? 4 : 2;
    if (!(this.cr0 & CR0_PE)) {
      const eip = this.peek(0, size);
      const cs = this.peek(size, size) & 0xffff;
      const flags = this.peek(size * 2, size);
      const target = o32 ? eip : eip & 0xffff;
      if (target >>> 0 > this.segLimit[CS]) this.gp(0);
      this.setSp(this.sp + size * 3);
      this.loadSegReal(CS, cs);
      this.eip = target;
      if (o32) this.writeFlags(flags, EFLAGS_MASK & ~(VM | VIF | VIP));
      else this.writeFlags(flags, 0xffff);
      return;
    }
    if (this.flags & VM) {
      if (this.iopl < 3) this.gp(0);
      const eip = this.peek(0, size);
      const cs = this.peek(size, size) & 0xffff;
      const flags = this.peek(size * 2, size);
      this.setSp(this.sp + size * 3);
      this.loadSegReal(CS, cs);
      this.eip = eip & 0xffff;
      const mask = (o32 ? EFLAGS_MASK & ~(VM | VIF | VIP) : 0xffff) & ~IOPL;
      this.writeFlags(flags, mask);
      return;
    }
    if (this.flags & NT) {
      this.taskSwitch(this.sysRead16(this.trBase), TASK_IRET);
      return;
    }
    const newEip = this.peek(0, size);
    const newCs = this.peek(size, size) & 0xffff;
    const newFlags = this.peek(size * 2, size);
    if (o32 && newFlags & VM && this.cpl === 0) {
      this.iretToVm86(newEip, newCs, newFlags);
      return;
    }
    if ((newCs & 0xfffc) === 0) this.gp(0);
    if (!this.readDescriptor(newCs)) this.gp(newCs & 0xfffc);
    const attr = this.descAttr();
    const rpl = newCs & 3;
    const dpl = (attr >> 5) & 3;
    if ((attr & 0x18) !== 0x18 || rpl < this.cpl) this.gp(newCs & 0xfffc);
    if (attr & 4 ? dpl > rpl : dpl !== rpl) this.gp(newCs & 0xfffc);
    if (!(attr & 0x80)) this.raise(NP, newCs & 0xfffc);
    const csLo = this.descLo;
    const csHi = this.descHi;
    const csAddr = this.descAddr;

    let mask = CF | PF | AF | ZF | SF | TF | DF | OF | NT;
    if (o32) mask |= RF | AC | ID;
    if (this.cpl <= this.iopl) mask |= IF;
    if (this.cpl === 0) {
      mask |= IOPL;
      if (o32) mask |= VIF | VIP;
    }
    if (rpl > this.cpl) {
      // Back to an outer ring and its stack.
      const newEsp = this.peek(size * 3, size);
      const newSs = this.peek(size * 4, size) & 0xffff;
      this.checkStackSeg(newSs, rpl, GP);
      const ssBase = this.descBase();
      const ssLimit = this.descLimit();
      const ssAttr = this.descAttr();
      this.markAccessed();
      this.descLo = csLo;
      this.descHi = csHi;
      this.descAddr = csAddr;
      this.writeFlags(newFlags, mask);
      this.loadCs(newCs, rpl);
      this.eip = o32 ? newEip : newEip & 0xffff;
      this.setSegCache(SS, newSs, ssBase, ssLimit, ssAttr);
      if (this.stack32) this.regs[ESP] = newEsp;
      else this.setReg16(ESP, newEsp);
      this.nullInaccessibleSegments();
    } else {
      this.setSp(this.sp + size * 3);
      this.writeFlags(newFlags, mask);
      this.loadCs(newCs, rpl);
      this.eip = o32 ? newEip : newEip & 0xffff;
    }
  }

  private iretToVm86(eip: number, cs: number, flags: number): void {
    const esp = this.peek(12, 4);
    const ss = this.peek(16, 4);
    const es = this.peek(20, 4);
    const ds = this.peek(24, 4);
    const fs = this.peek(28, 4);
    const gs = this.peek(32, 4);
    this.setEflags(flags);
    this.loadSegReal(CS, cs);
    this.loadSegReal(SS, ss);
    this.loadSegReal(ES, es);
    this.loadSegReal(DS, ds);
    this.loadSegReal(FS, fs);
    this.loadSegReal(GS, gs);
    this.regs[ESP] = esp;
    this.eip = eip & 0xffff;
    this.setCpl(3);
  }

  // --- Far transfers -------------------------------------------------------------------

  private jumpFar(selector: number, offset: number): void {
    selector &= 0xffff;
    if (!(this.cr0 & CR0_PE) || this.flags & VM) {
      if (offset >>> 0 > this.segLimit[CS]) this.gp(0);
      this.loadSegReal(CS, selector);
      this.eip = offset;
      return;
    }
    if ((selector & 0xfffc) === 0) this.gp(0);
    if (!this.readDescriptor(selector)) this.gp(selector & 0xfffc);
    const attr = this.descAttr();
    const dpl = (attr >> 5) & 3;
    const rpl = selector & 3;
    if (attr & 0x10) {
      if (!(attr & 8)) this.gp(selector & 0xfffc);
      if (attr & 4 ? dpl > this.cpl : rpl > this.cpl || dpl !== this.cpl) this.gp(selector & 0xfffc);
      if (!(attr & 0x80)) this.raise(NP, selector & 0xfffc);
      if (offset >>> 0 > this.descLimit()) this.gp(0);
      this.loadCs(selector, this.cpl);
      this.eip = offset;
      return;
    }
    const type = attr & 0x1f;
    if (dpl < this.cpl || dpl < rpl) this.gp(selector & 0xfffc);
    if (!(attr & 0x80)) this.raise(NP, selector & 0xfffc);
    if (type === 1 || type === 9 || type === 5) {
      this.taskSwitch(selector, TASK_JMP);
      return;
    }
    if (type !== 4 && type !== 0xc) this.gp(selector & 0xfffc);
    const gate32 = type === 0xc;
    const target = this.descLo >>> 16;
    const gateOffset = gate32 ? (this.descHi & 0xffff0000) | (this.descLo & 0xffff) : this.descLo & 0xffff;
    if ((target & 0xfffc) === 0) this.gp(0);
    if (!this.readDescriptor(target)) this.gp(target & 0xfffc);
    const tAttr = this.descAttr();
    const tDpl = (tAttr >> 5) & 3;
    if ((tAttr & 0x18) !== 0x18 || (tAttr & 4 ? tDpl > this.cpl : tDpl !== this.cpl)) this.gp(target & 0xfffc);
    if (!(tAttr & 0x80)) this.raise(NP, target & 0xfffc);
    this.loadCs(target, this.cpl);
    this.eip = gateOffset;
  }

  private callFar(selector: number, offset: number): void {
    selector &= 0xffff;
    if (!(this.cr0 & CR0_PE) || this.flags & VM) {
      if (offset >>> 0 > this.segLimit[CS]) this.gp(0);
      this.pushV(this.sel[CS]);
      this.pushV(this.eip);
      this.loadSegReal(CS, selector);
      this.eip = offset;
      return;
    }
    if ((selector & 0xfffc) === 0) this.gp(0);
    if (!this.readDescriptor(selector)) this.gp(selector & 0xfffc);
    const attr = this.descAttr();
    const dpl = (attr >> 5) & 3;
    const rpl = selector & 3;
    if (attr & 0x10) {
      if (!(attr & 8)) this.gp(selector & 0xfffc);
      if (attr & 4 ? dpl > this.cpl : rpl > this.cpl || dpl !== this.cpl) this.gp(selector & 0xfffc);
      if (!(attr & 0x80)) this.raise(NP, selector & 0xfffc);
      if (offset >>> 0 > this.descLimit()) this.gp(0);
      this.pushV(this.sel[CS]);
      this.pushV(this.eip);
      this.loadCs(selector, this.cpl);
      this.eip = offset;
      return;
    }
    const type = attr & 0x1f;
    if (dpl < this.cpl || dpl < rpl) this.gp(selector & 0xfffc);
    if (!(attr & 0x80)) this.raise(NP, selector & 0xfffc);
    if (type === 1 || type === 9 || type === 5) {
      this.taskSwitch(selector, TASK_CALL);
      return;
    }
    if (type !== 4 && type !== 0xc) this.gp(selector & 0xfffc);
    const gate32 = type === 0xc;
    const gateSize = gate32 ? 4 : 2;
    const params = this.descHi & 0x1f;
    const target = this.descLo >>> 16;
    const gateOffset = gate32 ? (this.descHi & 0xffff0000) | (this.descLo & 0xffff) : this.descLo & 0xffff;
    if ((target & 0xfffc) === 0) this.gp(0);
    if (!this.readDescriptor(target)) this.gp(target & 0xfffc);
    const tAttr = this.descAttr();
    const tDpl = (tAttr >> 5) & 3;
    if ((tAttr & 0x18) !== 0x18 || tDpl > this.cpl) this.gp(target & 0xfffc);
    if (!(tAttr & 0x80)) this.raise(NP, target & 0xfffc);
    const csLo = this.descLo;
    const csHi = this.descHi;
    const csAddr = this.descAddr;

    if (!(tAttr & 4) && tDpl < this.cpl) {
      // To an inner ring: switch stacks and copy the parameters across.
      const { ss, esp } = this.tssStack(tDpl);
      this.checkStackSeg(ss, tDpl, TS);
      const ssBase = this.descBase();
      const ssLimit = this.descLimit();
      const ssAttr = this.descAttr();
      const ssLo = this.descLo;
      const ssHi = this.descHi;
      const ssAddr = this.descAddr;
      const frame: number[] = [this.sel[SS], this.regs[ESP]];
      for (let i = params - 1; i >= 0; i--) frame.push(this.peek(i * gateSize, gateSize));
      frame.push(this.sel[CS], this.eip);
      const big = (ssAttr & SEG_BIG) !== 0;
      let sp = esp;
      for (const value of frame) {
        sp = big ? (sp - gateSize) >>> 0 : (sp - gateSize) & 0xffff;
        if (sp > ssLimit - (gateSize - 1)) this.raise(SS_FAULT, ss & 0xfffc);
        if (gateSize === 4) this.sysWrite32(ssBase + sp, value);
        else this.sysWrite16(ssBase + sp, value);
      }
      this.descLo = ssLo;
      this.descHi = ssHi;
      this.descAddr = ssAddr;
      this.markAccessed();
      this.setSegCache(SS, ss, ssBase, ssLimit, ssAttr);
      this.regs[ESP] = big ? sp : (esp & ~0xffff) | sp;
      this.descLo = csLo;
      this.descHi = csHi;
      this.descAddr = csAddr;
      this.loadCs(target, tDpl);
      this.eip = gateOffset;
      return;
    }
    const cs = this.sel[CS];
    const eip = this.eip;
    if (gateSize === 4) {
      this.push32(cs);
      this.push32(eip);
    } else {
      this.push16(cs);
      this.push16(eip);
    }
    this.loadCs(target, this.cpl);
    this.eip = gateOffset;
  }

  private retFar(imm: number): void {
    const size = this.o32 ? 4 : 2;
    const eip = this.peek(0, size);
    const cs = this.peek(size, size) & 0xffff;
    if (!(this.cr0 & CR0_PE) || this.flags & VM) {
      const target = this.o32 ? eip : eip & 0xffff;
      if (target >>> 0 > this.segLimit[CS]) this.gp(0);
      this.setSp(this.sp + size * 2 + imm);
      this.loadSegReal(CS, cs);
      this.eip = target;
      return;
    }
    if ((cs & 0xfffc) === 0) this.gp(0);
    if (!this.readDescriptor(cs)) this.gp(cs & 0xfffc);
    const attr = this.descAttr();
    const rpl = cs & 3;
    const dpl = (attr >> 5) & 3;
    if ((attr & 0x18) !== 0x18 || rpl < this.cpl) this.gp(cs & 0xfffc);
    if (attr & 4 ? dpl > rpl : dpl !== rpl) this.gp(cs & 0xfffc);
    if (!(attr & 0x80)) this.raise(NP, cs & 0xfffc);
    if (rpl > this.cpl) {
      const csLo = this.descLo;
      const csHi = this.descHi;
      const csAddr = this.descAddr;
      const newEsp = this.peek(size * 2 + imm, size);
      const newSs = this.peek(size * 3 + imm, size) & 0xffff;
      this.checkStackSeg(newSs, rpl, GP);
      const ssBase = this.descBase();
      const ssLimit = this.descLimit();
      const ssAttr = this.descAttr();
      this.markAccessed();
      this.descLo = csLo;
      this.descHi = csHi;
      this.descAddr = csAddr;
      this.loadCs(cs, rpl);
      this.eip = this.o32 ? eip : eip & 0xffff;
      this.setSegCache(SS, newSs, ssBase, ssLimit, ssAttr);
      if (this.stack32) this.regs[ESP] = (newEsp + imm) | 0;
      else this.setReg16(ESP, newEsp + imm);
      this.nullInaccessibleSegments();
      return;
    }
    this.setSp(this.sp + size * 2 + imm);
    this.loadCs(cs, this.cpl);
    this.eip = this.o32 ? eip : eip & 0xffff;
  }

  // --- Tasks ---------------------------------------------------------------------------

  private taskSwitch(selector: number, reason: number): void {
    selector &= 0xffff;
    if (selector & 4) this.raise(TS, selector & 0xfffc);
    if (!this.readDescriptor(selector)) this.raise(TS, selector & 0xfffc);
    let type = (this.descHi >>> 8) & 0x1f;
    if (type === 5) {
      // A task gate: the TSS it names.
      selector = this.descLo >>> 16;
      if (selector & 4 || !this.readDescriptor(selector)) this.raise(TS, selector & 0xfffc);
      type = (this.descHi >>> 8) & 0x1f;
    }
    const busy = (type & 2) !== 0;
    if ((type & ~0xa) !== 1 || (reason === TASK_IRET ? !busy : busy)) this.raise(reason === TASK_IRET ? TS : GP, selector & 0xfffc);
    if (!(this.descHi & 0x8000)) this.raise(NP, selector & 0xfffc);
    const newBase = this.descBase();
    const newLimit = this.descLimit();
    const newAddr = this.descAddr;
    const new32 = (type & 8) !== 0;
    if (newLimit < (new32 ? 0x67 : 0x2b)) this.raise(TS, selector & 0xfffc);

    // Save this task.
    let flags = this.getEflags();
    if (reason === TASK_IRET) flags &= ~NT;
    const base = this.trBase;
    if (this.trType & 8) {
      this.sysWrite32(base + 0x20, this.eip);
      this.sysWrite32(base + 0x24, flags);
      for (let r = 0; r < 8; r++) this.sysWrite32(base + 0x28 + r * 4, this.regs[r]);
      for (let s = 0; s < 6; s++) this.sysWrite16(base + 0x48 + s * 4, this.sel[s]);
    } else {
      this.sysWrite16(base + 0x0e, this.eip);
      this.sysWrite16(base + 0x10, flags);
      for (let r = 0; r < 8; r++) this.sysWrite16(base + 0x12 + r * 2, this.regs[r]);
      for (let s = 0; s < 4; s++) this.sysWrite16(base + 0x22 + s * 2, this.sel[s]);
    }
    if (reason === TASK_JMP || reason === TASK_IRET) {
      // The old task is no longer busy.
      if (this.readDescriptor(this.trSel)) this.sysWrite32(this.descAddr + 4, this.descHi & ~0x200);
    }

    // Load the new one.
    const regs = new Array<number>(8);
    const sels = new Array<number>(6).fill(0);
    let eip: number;
    let cr3 = this.cr3;
    let ldt: number;
    if (new32) {
      cr3 = this.sysRead32(newBase + 0x1c);
      eip = this.sysRead32(newBase + 0x20);
      flags = this.sysRead32(newBase + 0x24);
      for (let r = 0; r < 8; r++) regs[r] = this.sysRead32(newBase + 0x28 + r * 4);
      for (let s = 0; s < 6; s++) sels[s] = this.sysRead16(newBase + 0x48 + s * 4);
      ldt = this.sysRead16(newBase + 0x60);
    } else {
      eip = this.sysRead16(newBase + 0x0e);
      flags = this.sysRead16(newBase + 0x10) | (this.getEflags() & 0xffff0000 & ~VM);
      for (let r = 0; r < 8; r++) regs[r] = this.sysRead16(newBase + 0x12 + r * 2) | (this.regs[r] & 0xffff0000);
      for (let s = 0; s < 4; s++) sels[s] = this.sysRead16(newBase + 0x22 + s * 2);
      ldt = this.sysRead16(newBase + 0x2a);
    }
    if (reason === TASK_CALL || reason === TASK_INT) {
      this.sysWrite16(newBase, this.trSel);
      flags |= NT;
    }
    if (reason !== TASK_IRET) {
      this.descAddr = newAddr;
      const hi = this.sysRead32(newAddr + 4);
      this.sysWrite32(newAddr + 4, hi | 0x200);
    }
    this.trSel = selector;
    this.trBase = newBase;
    this.trLimit = newLimit;
    this.trType = type | 2;
    this.cr0 |= CR0_TS;
    if (new32 && this.cr0 & CR0_PG && cr3 !== this.cr3) {
      this.cr3 = cr3;
      this.flushTlb();
    }
    this.regs.set(regs);
    this.eip = eip;
    this.setEflags(flags);

    // The LDT, then the segments.
    this.ldtSel = ldt;
    if ((ldt & 0xfffc) === 0) {
      this.ldtBase = this.ldtLimit = 0;
    } else {
      if (ldt & 4 || !this.readDescriptor(ldt) || ((this.descHi >>> 8) & 0x1f) !== 2) this.raise(TS, ldt & 0xfffc);
      this.ldtBase = this.descBase();
      this.ldtLimit = this.descLimit();
    }
    if (flags & VM) {
      for (let s = 0; s < 6; s++) this.loadSegReal(s, sels[s]);
      this.setCpl(3);
      return;
    }
    const cpl = sels[CS] & 3;
    this.setCpl(cpl);
    if (!this.readDescriptor(sels[CS]) || (this.descAttr() & 0x18) !== 0x18) this.raise(TS, sels[CS] & 0xfffc);
    this.loadCs(sels[CS], cpl);
    this.loadSegProtected(SS, sels[SS]);
    for (const seg of [ES, DS, FS, GS]) this.loadSegProtected(seg, sels[seg]);
  }

  // --- I/O -----------------------------------------------------------------------------

  /** In protected mode, ports above the I/O privilege level need the TSS's permission bitmap to allow them. */
  private checkIo(port: number, size: number): void {
    if (!(this.cr0 & CR0_PE) || (this.cpl <= this.iopl && !(this.flags & VM))) return;
    if (!(this.trType & 8) || this.trLimit < 0x67) this.gp(0);
    const mapBase = this.sysRead16(this.trBase + 0x66);
    const at = mapBase + (port >>> 3);
    if (at + 1 > this.trLimit) this.gp(0);
    const bits = this.sysRead16(this.trBase + at);
    if (bits & (((1 << size) - 1) << (port & 7))) this.gp(0);
  }

  private in(port: number, size: number): number {
    this.checkIo(port, size);
    if (size === 1) return this.host.in8(port);
    if (size === 2) return this.host.in16(port);
    return this.host.in32(port);
  }

  private out(port: number, size: number, value: number): void {
    this.checkIo(port, size);
    if (size === 1) this.host.out8(port, value & 0xff);
    else if (size === 2) this.host.out16(port, value & 0xffff);
    else this.host.out32(port, value);
  }

  // --- Decoding --------------------------------------------------------------------------

  private step(): void {
    this.startEip = this.eip;
    this.startEsp = this.regs[ESP];
    this.o32 = this.a32 = this.code32;
    this.segOv = -1;
    this.rep = 0;
    this.lock = false;
    this.startFetch();
    let op = this.fetch8();
    if (!PREFIXES[op]) {
      if (op < 0x80) this.exec00(op);
      else this.exec80(op);
      return;
    }
    for (let prefixes = 1; ; prefixes++) {
      switch (op) {
        case 0x26:
          this.segOv = ES;
          break;
        case 0x2e:
          this.segOv = CS;
          break;
        case 0x36:
          this.segOv = SS;
          break;
        case 0x3e:
          this.segOv = DS;
          break;
        case 0x64:
          this.segOv = FS;
          break;
        case 0x65:
          this.segOv = GS;
          break;
        case 0x66:
          this.o32 = !this.code32;
          break;
        case 0x67:
          this.a32 = !this.code32;
          break;
        case 0xf0:
          this.lock = true;
          break;
        case 0xf2:
          this.rep = 2;
          break;
        case 0xf3:
          this.rep = 3;
          break;
        default:
          if (this.lock && !this.lockable(op)) this.ud();
          if (op < 0x80) this.exec00(op);
          else this.exec80(op);
          return;
      }
      if (prefixes >= 14) this.gp(0);
      op = this.fetch8();
    }
  }

  /** Whether LOCK may come before this opcode (the memory form is checked once the ModR/M byte is known). */
  private lockable(op: number): boolean {
    if (op === 0x0f) return true;
    if (op < 0x38) return (op & 7) < 2;
    if (op >= 0x80 && op <= 0x83) return true;
    if (op === 0x86 || op === 0x87) return true;
    return op === 0xf6 || op === 0xf7 || op === 0xfe || op === 0xff;
  }

  /** After the ModR/M byte of a lockable instruction: LOCK needs a memory destination. */
  private checkLock(): void {
    if (this.lock && this.modrm >= 0xc0) this.ud();
  }

  private decodeModrm(): void {
    const m = this.fetch8();
    this.modrm = m;
    if (m >= 0xc0) return;
    if (this.a32) this.decodeEa32(m);
    else this.decodeEa16(m);
  }

  private decodeEa16(m: number): void {
    const mod = m >> 6;
    const r = this.regs;
    let off: number;
    let seg = DS;
    switch (m & 7) {
      case 0:
        off = r[EBX] + r[ESI];
        break;
      case 1:
        off = r[EBX] + r[EDI];
        break;
      case 2:
        off = r[EBP] + r[ESI];
        seg = SS;
        break;
      case 3:
        off = r[EBP] + r[EDI];
        seg = SS;
        break;
      case 4:
        off = r[ESI];
        break;
      case 5:
        off = r[EDI];
        break;
      case 6:
        if (mod === 0) {
          off = this.fetch16();
        } else {
          off = r[EBP];
          seg = SS;
        }
        break;
      default:
        off = r[EBX];
    }
    if (mod === 1) off += sx8(this.fetch8());
    else if (mod === 2) off += this.fetch16();
    this.ea = off & 0xffff;
    this.eaSeg = this.segOv >= 0 ? this.segOv : seg;
  }

  private decodeEa32(m: number): void {
    const mod = m >> 6;
    const rm = m & 7;
    const r = this.regs;
    let off: number;
    let seg = DS;
    if (rm === 4) {
      const sib = this.fetch8();
      const base = sib & 7;
      const index = (sib >> 3) & 7;
      if (base === 5 && mod === 0) {
        off = this.fetch32();
      } else {
        off = r[base];
        if (base === ESP || base === EBP) seg = SS;
      }
      if (index !== 4) off += r[index] << (sib >> 6);
    } else if (rm === 5 && mod === 0) {
      off = this.fetch32();
    } else {
      off = r[rm];
      if (rm === EBP) seg = SS;
    }
    if (mod === 1) off += sx8(this.fetch8());
    else if (mod === 2) off += this.fetch32();
    this.ea = off >>> 0;
    this.eaSeg = this.segOv >= 0 ? this.segOv : seg;
  }

  private get reg(): number {
    return (this.modrm >> 3) & 7;
  }

  private rm8(): number {
    const m = this.modrm;
    return m >= 0xc0 ? this.getReg8(m & 7) : this.read8(this.eaSeg, this.ea);
  }

  private setRm8(v: number): void {
    const m = this.modrm;
    if (m >= 0xc0) this.setReg8(m & 7, v);
    else this.write8(this.eaSeg, this.ea, v);
  }

  private rm16(): number {
    const m = this.modrm;
    return m >= 0xc0 ? this.regs[m & 7] & 0xffff : this.read16(this.eaSeg, this.ea);
  }

  private setRm16(v: number): void {
    const m = this.modrm;
    if (m >= 0xc0) this.setReg16(m & 7, v);
    else this.write16(this.eaSeg, this.ea, v);
  }

  private rm32(): number {
    const m = this.modrm;
    return m >= 0xc0 ? this.regs[m & 7] : this.read32(this.eaSeg, this.ea);
  }

  private setRm32(v: number): void {
    const m = this.modrm;
    if (m >= 0xc0) this.regs[m & 7] = v;
    else this.write32(this.eaSeg, this.ea, v);
  }

  private rmV(): number {
    return this.o32 ? this.rm32() : this.rm16();
  }

  private setRmV(v: number): void {
    if (this.o32) this.setRm32(v);
    else this.setRm16(v);
  }

  /** For read-modify-write instructions that read flags: the write must not fault after the flags change. */
  private checkRmWrite(size: number): void {
    if (this.modrm < 0xc0) this.checkWriteSeg(this.eaSeg, this.ea, size);
  }

  private requireMemory(): void {
    if (this.modrm >= 0xc0) this.ud();
  }

  private get topV(): number {
    return this.o32 ? 31 : 15;
  }

  /** The segment string sources use (DS unless overridden). */
  private get srcSeg(): number {
    return this.segOv >= 0 ? this.segOv : DS;
  }

  // --- Arithmetic --------------------------------------------------------------------------

  private alu(kind: number, a: number, b: number, top: number): number {
    let r: number;
    switch (kind) {
      case 0:
        r = (a + b) | 0;
        this.setAdd(a, b, r, top);
        return r;
      case 1:
        r = a | b;
        this.setLogic(r, top);
        return r;
      case 2:
        r = (a + b + this.cf()) | 0;
        this.setAdd(a, b, r, top);
        return r;
      case 3:
        r = (a - b - this.cf()) | 0;
        this.setSub(a, b, r, top);
        return r;
      case 4:
        r = a & b;
        this.setLogic(r, top);
        return r;
      case 6:
        r = a ^ b;
        this.setLogic(r, top);
        return r;
      default:
        r = (a - b) | 0;
        this.setSub(a, b, r, top);
        return r;
    }
  }

  private inc(v: number, top: number): number {
    const c = this.cf();
    const r = (v + 1) | 0;
    this.setAdd(v, 1, r, top);
    this.flags = (this.flags & ~CF) | c;
    this.lazyMask = ARITH_FLAGS & ~CF;
    return r;
  }

  private dec(v: number, top: number): number {
    const c = this.cf();
    const r = (v - 1) | 0;
    this.setSub(v, 1, r, top);
    this.flags = (this.flags & ~CF) | c;
    this.lazyMask = ARITH_FLAGS & ~CF;
    return r;
  }

  /** The ALU forms of opcodes 00-3F: op/8 picks ADD OR ADC SBB AND SUB XOR CMP, op%8 the operands. */
  private aluOp(op: number): void {
    const kind = op >> 3;
    switch (op & 7) {
      case 0: {
        this.decodeModrm();
        this.checkLock();
        if (kind === 2 || kind === 3) this.checkRmWrite(1);
        const r = this.alu(kind, this.rm8(), this.getReg8(this.reg), 7);
        if (kind !== 7) this.setRm8(r);
        return;
      }
      case 1: {
        this.decodeModrm();
        this.checkLock();
        if (this.o32) {
          if (kind === 2 || kind === 3) this.checkRmWrite(4);
          const r = this.alu(kind, this.rm32(), this.regs[this.reg], 31);
          if (kind !== 7) this.setRm32(r);
        } else {
          if (kind === 2 || kind === 3) this.checkRmWrite(2);
          const r = this.alu(kind, this.rm16(), this.regs[this.reg] & 0xffff, 15);
          if (kind !== 7) this.setRm16(r);
        }
        return;
      }
      case 2: {
        this.decodeModrm();
        const r = this.alu(kind, this.getReg8(this.reg), this.rm8(), 7);
        if (kind !== 7) this.setReg8(this.reg, r);
        return;
      }
      case 3: {
        this.decodeModrm();
        if (this.o32) {
          const r = this.alu(kind, this.regs[this.reg], this.rm32(), 31);
          if (kind !== 7) this.regs[this.reg] = r;
        } else {
          const r = this.alu(kind, this.regs[this.reg] & 0xffff, this.rm16(), 15);
          if (kind !== 7) this.setReg16(this.reg, r);
        }
        return;
      }
      case 4: {
        const r = this.alu(kind, this.regs[EAX] & 0xff, this.fetch8(), 7);
        if (kind !== 7) this.setReg8(EAX, r);
        return;
      }
      default: {
        if (this.o32) {
          const r = this.alu(kind, this.regs[EAX], this.fetch32(), 31);
          if (kind !== 7) this.regs[EAX] = r;
        } else {
          const r = this.alu(kind, this.regs[EAX] & 0xffff, this.fetch16(), 15);
          if (kind !== 7) this.setReg16(EAX, r);
        }
      }
    }
  }

  /** 80-83: an ALU operation with an immediate. */
  private aluImm(op: number): void {
    this.decodeModrm();
    const kind = this.reg;
    if (kind !== 7) this.checkLock();
    else if (this.lock) this.ud();
    if (op !== 0x81 && op !== 0x83) {
      if (kind === 2 || kind === 3) this.checkRmWrite(1);
      const a = this.rm8();
      const r = this.alu(kind, a, this.fetch8(), 7);
      if (kind !== 7) this.setRm8(r);
      return;
    }
    const size = this.o32 ? 4 : 2;
    if (kind === 2 || kind === 3) this.checkRmWrite(size);
    const a = this.rmV();
    let b: number;
    if (op === 0x83) b = this.o32 ? sx8(this.fetch8()) : sx8(this.fetch8()) & 0xffff;
    else b = this.fetchImmV();
    const r = this.alu(kind, a, b, this.topV);
    if (kind !== 7) this.setRmV(r);
  }

  /** Shifts and rotates (group 2): `kind` is the ModR/M reg field. Returns the result; flags as the 386 sets them. */
  private shift(kind: number, v: number, count: number, bits: number): number {
    count &= 0x1f;
    if (count === 0) return v;
    const top = bits - 1;
    const mask = bits === 32 ? -1 : (1 << bits) - 1;
    v &= mask;
    let r: number;
    let cf: number;
    switch (kind) {
      case 0: {
        const n = count % bits;
        r = n ? ((v << n) | (v >>> (bits - n))) & mask : v;
        cf = r & 1;
        this.setFlag(CF, cf !== 0);
        this.setFlag(OF, (((r >>> top) & 1) ^ cf) !== 0);
        return r;
      }
      case 1: {
        const n = count % bits;
        r = n ? ((v >>> n) | (v << (bits - n))) & mask : v;
        cf = (r >>> top) & 1;
        this.setFlag(CF, cf !== 0);
        this.setFlag(OF, (((r >>> top) ^ (r >>> (top - 1))) & 1) !== 0);
        return r;
      }
      case 2: {
        const n = count % (bits + 1);
        r = v;
        cf = this.cf();
        for (let i = 0; i < n; i++) {
          const out = (r >>> top) & 1;
          r = ((r << 1) | cf) & mask;
          cf = out;
        }
        this.setFlag(CF, cf !== 0);
        this.setFlag(OF, (((r >>> top) & 1) ^ cf) !== 0);
        return r;
      }
      case 3: {
        const n = count % (bits + 1);
        r = v;
        cf = this.cf();
        for (let i = 0; i < n; i++) {
          const out = r & 1;
          r = ((r >>> 1) | (cf << top)) & mask;
          cf = out;
        }
        this.setFlag(CF, cf !== 0);
        this.setFlag(OF, (((r >>> top) ^ (r >>> (top - 1))) & 1) !== 0);
        return r;
      }
      // For counts beyond the operand size the 386's carry is zero, except at whole multiples
      // of the size, where it is the bit that a shift by the size itself would give.
      case 4:
      case 6: {
        r = count < bits ? (v << count) & mask : 0;
        if (count <= bits) cf = ((v << (count - 1)) >>> top) & 1;
        else cf = count % bits === 0 ? v & 1 : 0;
        this.setResultFlags(r, top, cf, (((r >>> top) & 1) ^ cf) !== 0);
        return r;
      }
      case 5: {
        r = count < bits ? v >>> count : 0;
        if (count <= bits) cf = (v >>> (count - 1)) & 1;
        else cf = count % bits === 0 ? (v >>> top) & 1 : 0;
        this.setResultFlags(r, top, cf, count === 1 ? ((v >>> top) & 1) !== 0 : (((r >>> top) ^ (r >>> (top - 1))) & 1) !== 0);
        return r;
      }
      default: {
        const s = (v << (32 - bits)) >> (32 - bits);
        r = (s >> count) & mask;
        cf = (s >> (count - 1)) & 1;
        this.setResultFlags(r, top, cf, false);
        return r;
      }
    }
  }

  private shiftOp(op: number): void {
    this.decodeModrm();
    const kind = this.reg;
    let count: number;
    if (op === 0xc0 || op === 0xc1) count = this.fetch8();
    else if (op === 0xd0 || op === 0xd1) count = 1;
    else count = this.regs[ECX] & 0xff;
    if (op & 1) {
      if (this.o32) {
        this.checkRmWrite(4);
        this.setRm32(this.shift(kind, this.rm32(), count, 32));
      } else {
        this.checkRmWrite(2);
        this.setRm16(this.shift(kind, this.rm16(), count, 16));
      }
    } else {
      this.checkRmWrite(1);
      this.setRm8(this.shift(kind, this.rm8(), count, 8));
    }
  }

  /** SHLD and SHRD. */
  private doubleShift(left: boolean, count: number): void {
    count &= 0x1f;
    const src = this.getRegV(this.reg);
    if (this.o32) {
      const dest = this.rm32();
      if (count === 0) return;
      let r: number;
      let cf: number;
      if (left) {
        r = (dest << count) | (src >>> (32 - count));
        cf = (dest >>> (32 - count)) & 1;
        this.setResultFlags(r, 31, cf, ((r >>> 31) ^ cf) !== 0);
      } else {
        r = (dest >>> count) | (src << (32 - count));
        cf = (dest >>> (count - 1)) & 1;
        this.setResultFlags(r, 31, cf, (((r >>> 31) ^ (r >>> 30)) & 1) !== 0);
      }
      this.setRm32(r);
      return;
    }
    const dest = this.rm16();
    if (count === 0) return;
    let r: number;
    let cf: number;
    // Beyond 16 bits the 386 shifts in the source again, as if it were dest:src:src (src:src:dest to the right).
    if (left) {
      if (count <= 16) r = ((((dest << 16) | src) << count) >>> 16) & 0xffff;
      else r = ((src << (count - 16)) | (src >>> (32 - count))) & 0xffff;
      cf = count <= 16 ? (dest >>> (16 - count)) & 1 : (src >>> (32 - count)) & 1;
      this.setResultFlags(r, 15, cf, (((r >>> 15) & 1) ^ cf) !== 0);
    } else {
      if (count <= 16) r = ((((src << 16) | dest) >>> 0) >>> count) & 0xffff;
      else r = ((src >>> (count - 16)) | (src << (32 - count))) & 0xffff;
      cf = count <= 16 ? (dest >>> (count - 1)) & 1 : (src >>> (count - 17)) & 1;
      this.setResultFlags(r, 15, cf, (((r >>> 15) ^ (r >>> 14)) & 1) !== 0);
    }
    this.setRm16(r);
  }

  /** Unsigned 32 x 32 bit multiply: the low and high halves. */
  private mul32(a: number, b: number): [number, number] {
    const lo = Math.imul(a, b);
    const al = a & 0xffff;
    const ah = a >>> 16;
    const bl = b & 0xffff;
    const bh = b >>> 16;
    const mid1 = ah * bl;
    const mid2 = al * bh;
    const low = al * bl;
    const carry = Math.floor((low + (mid1 % 0x10000) * 0x10000 + (mid2 % 0x10000) * 0x10000) / 0x100000000);
    const hi = ah * bh + Math.floor(mid1 / 0x10000) + Math.floor(mid2 / 0x10000) + carry;
    return [lo, hi | 0];
  }

  /** Signed 32 x 32 bit multiply. */
  private imul32(a: number, b: number): [number, number] {
    const [lo, hi] = this.mul32(a, b);
    let h = hi;
    if (a < 0) h -= b;
    if (b < 0) h -= a;
    return [lo, h | 0];
  }

  /** Group 3 (F6/F7): TEST, NOT, NEG, MUL, IMUL, DIV, IDIV. */
  private group3(op: number): void {
    this.decodeModrm();
    const kind = this.reg;
    if (kind === 2 || kind === 3) this.checkLock();
    else if (this.lock) this.ud();
    if (op === 0xf6) {
      const v = this.rm8();
      switch (kind) {
        case 0:
        case 1:
          this.setLogic(v & this.fetch8(), 7);
          return;
        case 2:
          this.setRm8(~v);
          return;
        case 3: {
          const r = -v | 0;
          this.setRm8(r);
          this.setSub(0, v, r, 7);
          return;
        }
        case 4: {
          const r = (this.regs[EAX] & 0xff) * v;
          this.setReg16(EAX, r);
          const high = r >> 8 !== 0;
          this.setResultFlags(r, 15, high ? 1 : 0, high);
          return;
        }
        case 5: {
          const r = sx8(this.regs[EAX]) * sx8(v);
          this.setReg16(EAX, r);
          const over = r !== sx8(r);
          this.setResultFlags(r, 15, over ? 1 : 0, over);
          return;
        }
        case 6: {
          if (v === 0) this.raise(DE);
          const ax = this.regs[EAX] & 0xffff;
          const q = Math.floor(ax / v);
          if (q > 0xff) this.raise(DE);
          this.setReg16(EAX, ((ax % v) << 8) | q);
          return;
        }
        default: {
          if (v === 0) this.raise(DE);
          const ax = sx16(this.regs[EAX]);
          const d = sx8(v);
          const q = Math.trunc(ax / d);
          if (q > 127 || q < -128) this.raise(DE);
          this.setReg16(EAX, (((ax % d) & 0xff) << 8) | (q & 0xff));
          return;
        }
      }
    }
    if (!this.o32) {
      const v = this.rm16();
      switch (kind) {
        case 0:
        case 1:
          this.setLogic(v & this.fetch16(), 15);
          return;
        case 2:
          this.setRm16(~v);
          return;
        case 3: {
          const r = -v | 0;
          this.setRm16(r);
          this.setSub(0, v, r, 15);
          return;
        }
        case 4: {
          const r = (this.regs[EAX] & 0xffff) * v;
          this.setReg16(EAX, r);
          this.setReg16(EDX, r >>> 16);
          const high = r >>> 16 !== 0;
          this.setResultFlags(r, 15, high ? 1 : 0, high);
          return;
        }
        case 5: {
          const r = sx16(this.regs[EAX]) * sx16(v);
          this.setReg16(EAX, r);
          this.setReg16(EDX, r >> 16);
          const over = r !== sx16(r);
          this.setResultFlags(r, 15, over ? 1 : 0, over);
          return;
        }
        case 6: {
          if (v === 0) this.raise(DE);
          const n = ((this.regs[EDX] & 0xffff) * 0x10000 + (this.regs[EAX] & 0xffff)) >>> 0;
          const q = Math.floor(n / v);
          if (q > 0xffff) this.raise(DE);
          this.setReg16(EAX, q);
          this.setReg16(EDX, n % v);
          return;
        }
        default: {
          if (v === 0) this.raise(DE);
          const n = ((this.regs[EDX] & 0xffff) << 16) | (this.regs[EAX] & 0xffff);
          const d = sx16(v);
          const q = Math.trunc(n / d);
          if (q > 32767 || q < -32768) this.raise(DE);
          this.setReg16(EAX, q);
          this.setReg16(EDX, n % d);
          return;
        }
      }
    }
    const v = this.rm32();
    switch (kind) {
      case 0:
      case 1:
        this.setLogic(v & this.fetch32(), 31);
        return;
      case 2:
        this.setRm32(~v);
        return;
      case 3: {
        const r = -v | 0;
        this.setRm32(r);
        this.setSub(0, v, r, 31);
        return;
      }
      case 4: {
        const [lo, hi] = this.mul32(this.regs[EAX], v);
        this.regs[EAX] = lo;
        this.regs[EDX] = hi;
        this.setResultFlags(lo, 31, hi !== 0 ? 1 : 0, hi !== 0);
        return;
      }
      case 5: {
        const [lo, hi] = this.imul32(this.regs[EAX], v);
        this.regs[EAX] = lo;
        this.regs[EDX] = hi;
        const over = hi !== lo >> 31;
        this.setResultFlags(lo, 31, over ? 1 : 0, over);
        return;
      }
      case 6: {
        const d = v >>> 0;
        if (d === 0) this.raise(DE);
        const hi = this.regs[EDX] >>> 0;
        const lo = this.regs[EAX] >>> 0;
        if (hi >= d) this.raise(DE);
        if (hi === 0) {
          this.regs[EAX] = Math.floor(lo / d);
          this.regs[EDX] = lo % d;
          return;
        }
        const n = (BigInt(hi) << 32n) | BigInt(lo);
        const bd = BigInt(d);
        this.regs[EAX] = Number(n / bd);
        this.regs[EDX] = Number(n % bd);
        return;
      }
      default: {
        if (v === 0) this.raise(DE);
        const n = (BigInt(this.regs[EDX]) << 32n) | BigInt(this.regs[EAX] >>> 0);
        const bd = BigInt(v);
        const q = n / bd;
        if (q > 0x7fffffffn || q < -0x80000000n) this.raise(DE);
        this.regs[EAX] = Number(q);
        this.regs[EDX] = Number(n % bd);
      }
    }
  }

  /** IMUL with two or three operands: the result truncated, CF and OF if it didn't fit. */
  private imulTruncated(a: number, b: number): number {
    if (this.o32) {
      const [lo, hi] = this.imul32(a, b);
      const over = hi !== lo >> 31;
      this.setResultFlags(lo, 31, over ? 1 : 0, over);
      return lo;
    }
    const r = sx16(a) * sx16(b);
    const over = r !== sx16(r);
    this.setResultFlags(r, 15, over ? 1 : 0, over);
    return r;
  }

  // --- String instructions -----------------------------------------------------------------

  private get countReg(): number {
    return this.a32 ? this.regs[ECX] >>> 0 : this.regs[ECX] & 0xffff;
  }

  private setCount(v: number): void {
    if (this.a32) this.regs[ECX] = v;
    else this.setReg16(ECX, v);
  }

  private index(r: number): number {
    return this.a32 ? this.regs[r] >>> 0 : this.regs[r] & 0xffff;
  }

  private advance(r: number, delta: number): void {
    if (this.a32) this.regs[r] = (this.regs[r] + delta) | 0;
    else this.setReg16(r, this.regs[r] + delta);
  }

  private stringOp(op: number): void {
    const size = op & 1 ? (this.o32 ? 4 : 2) : 1;
    const delta = this.flags & DF ? -size : size;
    const rep = this.rep !== 0;
    if (rep && this.countReg === 0) return;
    for (;;) {
      switch (op) {
        case 0xa4:
        case 0xa5: {
          const v = this.readSized(this.srcSeg, this.index(ESI), size);
          this.writeSized(ES, this.index(EDI), size, v);
          this.advance(ESI, delta);
          this.advance(EDI, delta);
          break;
        }
        case 0xa6:
        case 0xa7: {
          const a = this.readSized(this.srcSeg, this.index(ESI), size);
          const b = this.readSized(ES, this.index(EDI), size);
          this.alu(7, a, b, size * 8 - 1);
          this.advance(ESI, delta);
          this.advance(EDI, delta);
          break;
        }
        case 0xaa:
        case 0xab:
          this.writeSized(ES, this.index(EDI), size, this.regs[EAX]);
          this.advance(EDI, delta);
          break;
        case 0xac:
        case 0xad: {
          const v = this.readSized(this.srcSeg, this.index(ESI), size);
          if (size === 1) this.setReg8(EAX, v);
          else if (size === 2) this.setReg16(EAX, v);
          else this.regs[EAX] = v;
          this.advance(ESI, delta);
          break;
        }
        case 0xae:
        case 0xaf: {
          const a = size === 4 ? this.regs[EAX] : this.regs[EAX] & (size === 2 ? 0xffff : 0xff);
          this.alu(7, a, this.readSized(ES, this.index(EDI), size), size * 8 - 1);
          this.advance(EDI, delta);
          break;
        }
        case 0x6c:
        case 0x6d: {
          const port = this.regs[EDX] & 0xffff;
          this.checkWriteSeg(ES, this.index(EDI), size);
          const v = this.in(port, size);
          this.writeSized(ES, this.index(EDI), size, v);
          this.advance(EDI, delta);
          break;
        }
        default: {
          const port = this.regs[EDX] & 0xffff;
          this.out(port, size, this.readSized(this.srcSeg, this.index(ESI), size));
          this.advance(ESI, delta);
        }
      }
      if (!rep) return;
      const count = (this.countReg - 1) >>> 0;
      this.setCount(count);
      this.cycles++;
      if (count === 0) return;
      if ((op & 0xf6) === 0xa6) {
        // CMPS and SCAS: REPE stops on a difference, REPNE on a match.
        if (this.rep === 3 ? !this.zf() : this.zf()) return;
      }
    }
  }

  private readSized(seg: number, off: number, size: number): number {
    if (size === 1) return this.read8(seg, off);
    if (size === 2) return this.read16(seg, off);
    return this.read32(seg, off);
  }

  private writeSized(seg: number, off: number, size: number, v: number): void {
    if (size === 1) this.write8(seg, off, v);
    else if (size === 2) this.write16(seg, off, v);
    else this.write32(seg, off, v);
  }

  // --- BCD ---------------------------------------------------------------------------------

  private daa(): void {
    const al = this.regs[EAX] & 0xff;
    const cf = this.cf();
    let r = al;
    let newCf = 0;
    let af = false;
    if ((al & 0xf) > 9 || this.af()) {
      r = al + 6;
      newCf = cf | (r > 0xff ? 1 : 0);
      af = true;
    }
    if (al > 0x99 || cf) {
      r += 0x60;
      newCf = 1;
    }
    r &= 0xff;
    this.setReg8(EAX, r);
    this.setResultFlags(r, 7, newCf, false, af);
  }

  private das(): void {
    const al = this.regs[EAX] & 0xff;
    const cf = this.cf();
    let r = al;
    let newCf = 0;
    let af = false;
    if ((al & 0xf) > 9 || this.af()) {
      r = al - 6;
      newCf = cf | (r < 0 ? 1 : 0);
      af = true;
    }
    if (al > 0x99 || cf) {
      r -= 0x60;
      newCf = 1;
    }
    r &= 0xff;
    this.setReg8(EAX, r);
    this.setResultFlags(r, 7, newCf, false, af);
  }

  private aaa(subtract: boolean): void {
    let ax = this.regs[EAX] & 0xffff;
    const adjust = (ax & 0xf) > 9 || this.af();
    if (adjust) ax = subtract ? ax - 6 - 0x100 : ax + 0x106;
    ax &= 0xff0f;
    this.setReg16(EAX, ax);
    this.setResultFlags(ax & 0xff, 7, adjust ? 1 : 0, false, adjust);
  }

  // --- Bit operations ----------------------------------------------------------------------

  /** BT, BTS, BTR, BTC: kind 0-3; `bit` from a register can reach beyond the operand in memory. */
  private bitOp(kind: number, bit: number, fromRegister: boolean): void {
    const bits = this.o32 ? 32 : 16;
    if (this.modrm < 0xc0 && fromRegister) {
      const disp = this.o32 ? (bit >> 5) * 4 : (sx16(bit) >> 4) * 2;
      this.ea = this.a32 ? (this.ea + disp) >>> 0 : (this.ea + disp) & 0xffff;
    }
    bit &= bits - 1;
    if (kind !== 0) this.checkRmWrite(bits / 8);
    const v = this.rmV();
    const cf = (v >>> bit) & 1;
    this.setFlag(CF, cf !== 0);
    if (kind === 0) return;
    const m = 1 << bit;
    if (kind === 1) this.setRmV(v | m);
    else if (kind === 2) this.setRmV(v & ~m);
    else this.setRmV(v ^ m);
  }

  // --- System instructions -------------------------------------------------------------

  private requireCpl0(): void {
    if (this.cpl !== 0) this.gp(0);
  }

  private requireProtected(): void {
    if (!(this.cr0 & CR0_PE) || this.flags & VM) this.ud();
  }

  private writeCr(n: number, v: number): void {
    switch (n) {
      case 0: {
        if (v & CR0_PG && !(v & CR0_PE)) this.gp(0);
        const changed = this.cr0 ^ v;
        this.cr0 = v | CR0_ET;
        if (changed & (CR0_PG | CR0_WP | CR0_PE)) this.flushTlb();
        if (changed & CR0_PE && !(v & CR0_PE)) for (let seg = 0; seg < 6; seg++) this.makeRealModeAccessible(seg);
        return;
      }
      case 2:
        this.cr2 = v;
        return;
      case 3:
        this.cr3 = v;
        this.flushTlb();
        return;
      case 4: {
        const changed = this.cr4 ^ v;
        this.cr4 = v & (CR4_TSD | CR4_PSE | 0x8 | 0x1 | 0x2);
        if (changed & CR4_PSE) this.flushTlb();
        return;
      }
      default:
        this.ud();
    }
  }

  private readCr(n: number): number {
    switch (n) {
      case 0:
        return this.cr0;
      case 2:
        return this.cr2;
      case 3:
        return this.cr3;
      case 4:
        return this.cr4;
      default:
        this.ud();
    }
  }

  get tsc(): number {
    return this.cycles + this.tscOffset;
  }

  private cpuid(): void {
    const leaf = this.regs[EAX];
    const r = this.regs;
    if (leaf === 0) {
      r[EAX] = 1;
      r[EBX] = 0x756e6547; // "Genu"
      r[EDX] = 0x49656e69; // "ineI"
      r[ECX] = 0x6c65746e; // "ntel"
    } else if (leaf === 1) {
      r[EAX] = CPU_SIGNATURE;
      r[EBX] = 0;
      r[ECX] = 0;
      r[EDX] = CPU_FEATURES;
    } else {
      r[EAX] = r[EBX] = r[ECX] = r[EDX] = 0;
    }
  }

  private rdmsr(): void {
    this.requireCpl0();
    const msr = this.regs[ECX] >>> 0;
    if (msr === 0x10) {
      const t = this.tsc;
      this.regs[EAX] = t % 0x100000000;
      this.regs[EDX] = Math.floor(t / 0x100000000);
    } else {
      this.regs[EAX] = this.regs[EDX] = 0;
    }
  }

  private wrmsr(): void {
    this.requireCpl0();
    const msr = this.regs[ECX] >>> 0;
    if (msr === 0x10) this.tscOffset = (this.regs[EDX] >>> 0) * 0x100000000 + (this.regs[EAX] >>> 0) - this.cycles;
  }

  /** LAR and LSL: whether a descriptor is visible at this privilege (ZF), and its attributes or limit. */
  private loadAccessRights(limit: boolean): void {
    this.requireProtected();
    this.decodeModrm();
    const selector = this.rm16();
    let ok = false;
    if ((selector & 0xfffc) !== 0 && this.readDescriptor(selector)) {
      const attr = this.descAttr();
      const dpl = (attr >> 5) & 3;
      const type = attr & 0x1f;
      const conformingCode = (attr & 0x1c) === 0x1c;
      let validType: boolean;
      if (attr & 0x10) validType = true;
      else validType = limit ? [1, 2, 3, 9, 11].includes(type) : [1, 2, 3, 4, 5, 9, 11, 12].includes(type);
      ok = validType && (conformingCode || (dpl >= this.cpl && dpl >= (selector & 3)));
    }
    this.setFlag(ZF, ok);
    if (!ok) return;
    if (limit) this.setRegV(this.reg, this.descLimit());
    else this.setRegV(this.reg, this.descHi & 0x00f0ff00);
  }

  private verify(write: boolean): void {
    this.requireProtected();
    const selector = this.rm16();
    let ok = false;
    if ((selector & 0xfffc) !== 0 && this.readDescriptor(selector)) {
      const attr = this.descAttr();
      const dpl = (attr >> 5) & 3;
      if (attr & 0x10) {
        const code = (attr & 8) !== 0;
        const conforming = code && (attr & 4) !== 0;
        const privileged = conforming || (dpl >= this.cpl && dpl >= (selector & 3));
        ok = privileged && (write ? !code && (attr & 2) !== 0 : !code || (attr & 2) !== 0);
      }
    }
    this.setFlag(ZF, ok);
  }

  private group6(): void {
    this.requireProtected();
    this.decodeModrm();
    switch (this.reg) {
      case 0:
        if (this.modrm >= 0xc0) this.setRegV(this.modrm & 7, this.ldtSel);
        else this.setRm16(this.ldtSel);
        return;
      case 1:
        if (this.modrm >= 0xc0) this.setRegV(this.modrm & 7, this.trSel);
        else this.setRm16(this.trSel);
        return;
      case 2: {
        this.requireCpl0();
        const selector = this.rm16();
        if ((selector & 0xfffc) === 0) {
          this.ldtSel = selector;
          this.ldtBase = this.ldtLimit = 0;
          return;
        }
        if (selector & 4 || !this.readDescriptor(selector)) this.gp(selector & 0xfffc);
        if (((this.descHi >>> 8) & 0x1f) !== 2) this.gp(selector & 0xfffc);
        if (!(this.descHi & 0x8000)) this.raise(NP, selector & 0xfffc);
        this.ldtSel = selector;
        this.ldtBase = this.descBase();
        this.ldtLimit = this.descLimit();
        return;
      }
      case 3: {
        this.requireCpl0();
        const selector = this.rm16();
        if ((selector & 0xfffc) === 0) this.gp(0);
        if (selector & 4 || !this.readDescriptor(selector)) this.gp(selector & 0xfffc);
        const type = (this.descHi >>> 8) & 0x1f;
        if (type !== 1 && type !== 9) this.gp(selector & 0xfffc);
        if (!(this.descHi & 0x8000)) this.raise(NP, selector & 0xfffc);
        this.sysWrite32(this.descAddr + 4, this.descHi | 0x200);
        this.trSel = selector;
        this.trBase = this.descBase();
        this.trLimit = this.descLimit();
        this.trType = type | 2;
        return;
      }
      case 4:
        this.verify(false);
        return;
      case 5:
        this.verify(true);
        return;
      default:
        this.ud();
    }
  }

  private group7(): void {
    this.decodeModrm();
    const kind = this.reg;
    switch (kind) {
      case 0:
      case 1: {
        this.requireMemory();
        const limit = kind === 0 ? this.gdtLimit : this.idtLimit;
        const base = kind === 0 ? this.gdtBase : this.idtBase;
        this.checkWriteSeg(this.eaSeg, this.ea, 6);
        this.write16(this.eaSeg, this.ea, limit);
        this.write32(this.eaSeg, this.eaOffset(2), this.o32 ? base : base & 0xffffff);
        return;
      }
      case 2:
      case 3: {
        this.requireMemory();
        this.requireCpl0();
        const limit = this.read16(this.eaSeg, this.ea);
        let base = this.read32(this.eaSeg, this.eaOffset(2)) >>> 0;
        if (!this.o32) base &= 0xffffff;
        if (kind === 2) {
          this.gdtLimit = limit;
          this.gdtBase = base;
        } else {
          this.idtLimit = limit;
          this.idtBase = base;
        }
        return;
      }
      case 4:
        if (this.modrm >= 0xc0) this.setRegV(this.modrm & 7, this.cr0);
        else this.setRm16(this.cr0);
        return;
      case 6: {
        this.requireCpl0();
        const v = this.rm16();
        this.writeCr(0, (this.cr0 & ~0xe) | (v & 0xf) | (this.cr0 & CR0_PE));
        return;
      }
      case 7:
        this.requireMemory();
        this.requireCpl0();
        this.tlb[((this.segBase[this.eaSeg] + this.ea) | 0) >>> 12] = 0;
        this.fetchPage = -1;
        return;
      default:
        this.ud();
    }
  }

  // --- One-byte opcodes 00-7F ----------------------------------------------------------

  private exec00(op: number): void {
    const r = this.regs;
    switch (op) {
      case 0x06:
      case 0x0e:
      case 0x16:
      case 0x1e:
        this.pushV(this.sel[op >> 3]);
        return;
      case 0x07:
      case 0x17:
      case 0x1f: {
        const seg = op >> 3;
        // Only the selector's word is read, even with a 32-bit operand size.
        const v = this.peek(0, 2);
        this.loadSeg(seg, v);
        this.setSp(this.sp + (this.o32 ? 4 : 2));
        if (seg === SS) this.inhibit = true;
        return;
      }
      case 0x0f:
        this.exec0f();
        return;
      case 0x27:
        this.daa();
        return;
      case 0x2f:
        this.das();
        return;
      case 0x37:
        this.aaa(false);
        return;
      case 0x3f:
        this.aaa(true);
        return;
      case 0x40:
      case 0x41:
      case 0x42:
      case 0x43:
      case 0x44:
      case 0x45:
      case 0x46:
      case 0x47:
        if (this.o32) r[op & 7] = this.inc(r[op & 7], 31);
        else this.setReg16(op & 7, this.inc(r[op & 7] & 0xffff, 15));
        return;
      case 0x48:
      case 0x49:
      case 0x4a:
      case 0x4b:
      case 0x4c:
      case 0x4d:
      case 0x4e:
      case 0x4f:
        if (this.o32) r[op & 7] = this.dec(r[op & 7], 31);
        else this.setReg16(op & 7, this.dec(r[op & 7] & 0xffff, 15));
        return;
      case 0x50:
      case 0x51:
      case 0x52:
      case 0x53:
      case 0x54:
      case 0x55:
      case 0x56:
      case 0x57:
        this.pushV(r[op & 7]);
        return;
      case 0x58:
      case 0x59:
      case 0x5a:
      case 0x5b:
      case 0x5c:
      case 0x5d:
      case 0x5e:
      case 0x5f: {
        const v = this.popV();
        this.setRegV(op & 7, v);
        return;
      }
      case 0x60: {
        const sp = r[ESP];
        for (let i = 0; i < 8; i++) this.pushV(i === ESP ? sp : r[i]);
        return;
      }
      case 0x61: {
        // Registers are written as they are popped: a fault part way leaves the earlier ones changed, as on the 386.
        const size = this.o32 ? 4 : 2;
        let poppedEsp = 0;
        for (let i = 0; i < 8; i++) {
          const v = this.peek(i * size, size);
          if (7 - i !== ESP) this.setRegV(7 - i, v);
          else poppedEsp = v;
        }
        this.setSp(this.sp + size * 8);
        // On a 16-bit stack the 386's POPAD takes ESP's upper half from the popped value.
        if (this.o32 && !this.stack32) r[ESP] = (poppedEsp & ~0xffff) | (r[ESP] & 0xffff);
        return;
      }
      case 0x62: {
        this.decodeModrm();
        this.requireMemory();
        if (this.o32) {
          const lo = this.read32(this.eaSeg, this.ea);
          const hi = this.read32(this.eaSeg, this.eaOffset(4));
          const v = r[this.reg];
          if (v < lo || v > hi) this.raise(BR);
        } else {
          const lo = sx16(this.read16(this.eaSeg, this.ea));
          const hi = sx16(this.read16(this.eaSeg, this.eaOffset(2)));
          const v = sx16(r[this.reg]);
          if (v < lo || v > hi) this.raise(BR);
        }
        return;
      }
      case 0x63: {
        this.requireProtected();
        this.decodeModrm();
        const dest = this.rm16();
        const src = r[this.reg] & 3;
        if ((dest & 3) < src) {
          this.setRm16((dest & ~3) | src);
          this.setFlag(ZF, true);
        } else {
          this.setFlag(ZF, false);
        }
        return;
      }
      case 0x68:
        this.pushV(this.fetchImmV());
        return;
      case 0x6a:
        this.pushV(sx8(this.fetch8()));
        return;
      case 0x69:
      case 0x6b: {
        this.decodeModrm();
        const a = this.rmV();
        const b = op === 0x6b ? sx8(this.fetch8()) : this.o32 ? this.fetch32() : sx16(this.fetch16());
        this.setRegV(this.reg, this.imulTruncated(a, b));
        return;
      }
      case 0x6c:
      case 0x6d:
      case 0x6e:
      case 0x6f:
        this.stringOp(op);
        return;
      default:
        if (op < 0x40) {
          if ((op & 7) < 6) this.aluOp(op);
          else this.ud();
          return;
        }
        if (op >= 0x70) {
          const rel = sx8(this.fetch8());
          if (this.cond(op & 0xf)) this.jumpNear(this.eip + rel);
          return;
        }
        this.ud();
    }
  }

  private jumpNear(target: number): void {
    target = this.o32 ? target | 0 : target & 0xffff;
    if (target >>> 0 > this.segLimit[CS]) this.gp(0);
    this.eip = target;
  }

  // --- One-byte opcodes 80-FF ----------------------------------------------------------

  private exec80(op: number): void {
    const r = this.regs;
    switch (op) {
      case 0x80:
      case 0x81:
      case 0x82:
      case 0x83:
        this.aluImm(op);
        return;
      case 0x84:
        this.decodeModrm();
        this.setLogic(this.rm8() & this.getReg8(this.reg), 7);
        return;
      case 0x85:
        this.decodeModrm();
        this.setLogic(this.rmV() & this.getRegV(this.reg), this.topV);
        return;
      case 0x86: {
        this.decodeModrm();
        this.checkLock();
        const v = this.rm8();
        this.setRm8(this.getReg8(this.reg));
        this.setReg8(this.reg, v);
        return;
      }
      case 0x87: {
        this.decodeModrm();
        this.checkLock();
        const v = this.rmV();
        this.setRmV(this.getRegV(this.reg));
        this.setRegV(this.reg, v);
        return;
      }
      case 0x88:
        this.decodeModrm();
        this.setRm8(this.getReg8(this.reg));
        return;
      case 0x89:
        this.decodeModrm();
        this.setRmV(r[this.reg]);
        return;
      case 0x8a:
        this.decodeModrm();
        this.setReg8(this.reg, this.rm8());
        return;
      case 0x8b:
        this.decodeModrm();
        this.setRegV(this.reg, this.rmV());
        return;
      case 0x8c:
        this.decodeModrm();
        if (this.reg > 5) this.ud();
        if (this.modrm >= 0xc0) this.setRegV(this.modrm & 7, this.sel[this.reg]);
        else this.setRm16(this.sel[this.reg]);
        return;
      case 0x8d:
        this.decodeModrm();
        this.requireMemory();
        this.setRegV(this.reg, this.ea);
        return;
      case 0x8e: {
        this.decodeModrm();
        const seg = this.reg;
        if (seg === CS || seg > 5) this.ud();
        this.loadSeg(seg, this.rm16());
        if (seg === SS) this.inhibit = true;
        return;
      }
      case 0x8f: {
        // POP r/m: ESP moves before the address is worked out.
        const size = this.o32 ? 4 : 2;
        const v = this.peek(0, size);
        this.setSp(this.sp + size);
        this.decodeModrm();
        if (this.reg !== 0) this.ud();
        this.setRmV(v);
        return;
      }
      case 0x90:
        return;
      case 0x91:
      case 0x92:
      case 0x93:
      case 0x94:
      case 0x95:
      case 0x96:
      case 0x97: {
        const v = this.getRegV(op & 7);
        this.setRegV(op & 7, this.getRegV(EAX));
        this.setRegV(EAX, v);
        return;
      }
      case 0x98:
        if (this.o32) r[EAX] = sx16(r[EAX]);
        else this.setReg16(EAX, sx8(r[EAX]));
        return;
      case 0x99:
        if (this.o32) r[EDX] = r[EAX] >> 31;
        else this.setReg16(EDX, sx16(r[EAX]) >> 16);
        return;
      case 0x9a: {
        const offset = this.fetchImmV();
        const selector = this.fetch16();
        this.callFar(selector, offset);
        return;
      }
      case 0x9b:
        if ((this.cr0 & (CR0_MP | CR0_TS)) === (CR0_MP | CR0_TS)) this.raise(NM);
        this.fpu.wait();
        return;
      case 0x9c: {
        if (this.flags & VM && this.iopl < 3) this.gp(0);
        const f = this.getEflags();
        if (this.o32) this.push32(f & ~(VM | RF));
        else this.push16(f);
        return;
      }
      case 0x9d: {
        if (this.flags & VM && this.iopl < 3) this.gp(0);
        const v = this.popV();
        let mask = CF | PF | AF | ZF | SF | TF | DF | OF | NT;
        if (this.o32) mask |= AC | ID;
        if (!(this.cr0 & CR0_PE) || this.cpl === 0) mask |= IOPL;
        if (!(this.cr0 & CR0_PE) || this.cpl <= this.iopl) mask |= IF;
        if (this.flags & VM) mask &= ~IOPL;
        this.writeFlags(v, mask);
        return;
      }
      case 0x9e: {
        const ah = (r[EAX] >> 8) & 0xff;
        this.writeFlags(ah, CF | PF | AF | ZF | SF);
        return;
      }
      case 0x9f:
        this.setReg8(4, (this.getEflags() & 0xd5) | 2);
        return;
      case 0xa0:
      case 0xa1:
      case 0xa2:
      case 0xa3: {
        const off = this.a32 ? this.fetch32() >>> 0 : this.fetch16();
        const seg = this.srcSeg;
        if (op === 0xa0) this.setReg8(EAX, this.read8(seg, off));
        else if (op === 0xa1) this.setRegV(EAX, this.o32 ? this.read32(seg, off) : this.read16(seg, off));
        else if (op === 0xa2) this.write8(seg, off, r[EAX]);
        else if (this.o32) this.write32(seg, off, r[EAX]);
        else this.write16(seg, off, r[EAX]);
        return;
      }
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
        this.stringOp(op);
        return;
      case 0xa8:
        this.setLogic(r[EAX] & this.fetch8() & 0xff, 7);
        return;
      case 0xa9:
        this.setLogic(this.getRegV(EAX) & this.fetchImmV(), this.topV);
        return;
      case 0xb0:
      case 0xb1:
      case 0xb2:
      case 0xb3:
      case 0xb4:
      case 0xb5:
      case 0xb6:
      case 0xb7:
        this.setReg8(op & 7, this.fetch8());
        return;
      case 0xb8:
      case 0xb9:
      case 0xba:
      case 0xbb:
      case 0xbc:
      case 0xbd:
      case 0xbe:
      case 0xbf:
        this.setRegV(op & 7, this.fetchImmV());
        return;
      case 0xc0:
      case 0xc1:
      case 0xd0:
      case 0xd1:
      case 0xd2:
      case 0xd3:
        this.shiftOp(op);
        return;
      case 0xc2: {
        const imm = this.fetch16();
        const target = this.popV();
        this.setSp(this.sp + imm);
        this.jumpNear(target);
        return;
      }
      case 0xc3:
        this.jumpNear(this.popV());
        return;
      case 0xc4:
      case 0xc5: {
        this.decodeModrm();
        this.requireMemory();
        const offset = this.o32 ? this.read32(this.eaSeg, this.ea) : this.read16(this.eaSeg, this.ea);
        const selector = this.read16(this.eaSeg, this.eaOffset(this.o32 ? 4 : 2));
        this.loadSeg(op === 0xc4 ? ES : DS, selector);
        this.setRegV(this.reg, offset);
        return;
      }
      case 0xc6:
        this.decodeModrm();
        if (this.reg !== 0) this.ud();
        this.setRm8(this.fetch8());
        return;
      case 0xc7:
        this.decodeModrm();
        if (this.reg !== 0) this.ud();
        this.setRmV(this.fetchImmV());
        return;
      case 0xc8:
        this.enter();
        return;
      case 0xc9: {
        const bp = this.stack32 ? r[EBP] >>> 0 : r[EBP] & 0xffff;
        const v = this.o32 ? this.read32(SS, bp) : this.read16(SS, bp);
        this.setSp(bp + (this.o32 ? 4 : 2));
        this.setRegV(EBP, v);
        return;
      }
      case 0xca:
        this.retFar(this.fetch16());
        return;
      case 0xcb:
        this.retFar(0);
        return;
      case 0xcc:
        if (this.flags & VM && this.iopl < 3) this.gp(0);
        this.interrupt(BP, INT_SOFT, -1);
        return;
      case 0xcd:
        this.softwareInterrupt(this.fetch8());
        return;
      case 0xce:
        if (!this.of()) return;
        if (this.flags & VM && this.iopl < 3) this.gp(0);
        this.interrupt(OVERFLOW, INT_SOFT, -1);
        return;
      case 0xcf:
        this.iret();
        return;
      case 0xd4: {
        const base = this.fetch8();
        if (base === 0) {
          // The 386 leaves SF and ZF clear and PF set as it gives up.
          this.setResultFlags(3, 7, 0, false);
          this.raise(DE);
        }
        const al = r[EAX] & 0xff;
        const result = al % base;
        this.setReg16(EAX, (Math.floor(al / base) << 8) | result);
        this.setResultFlags(result, 7, 0, false);
        return;
      }
      case 0xd5: {
        const base = this.fetch8();
        const al = ((r[EAX] & 0xff) + ((r[EAX] >> 8) & 0xff) * base) & 0xff;
        this.setReg16(EAX, al);
        this.setResultFlags(al, 7, 0, false);
        return;
      }
      case 0xd6:
        this.setReg8(EAX, this.cf() ? 0xff : 0);
        return;
      case 0xd7: {
        const off = this.a32 ? (r[EBX] + (r[EAX] & 0xff)) >>> 0 : (r[EBX] + (r[EAX] & 0xff)) & 0xffff;
        this.setReg8(EAX, this.read8(this.srcSeg, off));
        return;
      }
      case 0xd8:
      case 0xd9:
      case 0xda:
      case 0xdb:
      case 0xdc:
      case 0xdd:
      case 0xde:
      case 0xdf:
        if (this.cr0 & (CR0_EM | CR0_TS)) this.raise(NM);
        this.decodeModrm();
        this.fpu.execute(op, this.modrm);
        return;
      case 0xe0:
      case 0xe1:
      case 0xe2: {
        const rel = sx8(this.fetch8());
        const count = (this.countReg - 1) >>> 0;
        this.setCount(count);
        const z = this.zf();
        if (count !== 0 && (op === 0xe2 || (op === 0xe1 ? z : !z))) this.jumpNear(this.eip + rel);
        return;
      }
      case 0xe3: {
        const rel = sx8(this.fetch8());
        if (this.countReg === 0) this.jumpNear(this.eip + rel);
        return;
      }
      case 0xe4:
        this.setReg8(EAX, this.in(this.fetch8(), 1));
        return;
      case 0xe5: {
        const port = this.fetch8();
        this.setRegV(EAX, this.in(port, this.o32 ? 4 : 2));
        return;
      }
      case 0xe6:
        this.out(this.fetch8(), 1, r[EAX]);
        return;
      case 0xe7:
        this.out(this.fetch8(), this.o32 ? 4 : 2, r[EAX]);
        return;
      case 0xe8: {
        const rel = this.o32 ? this.fetch32() : sx16(this.fetch16());
        const ret = this.eip;
        this.pushV(ret);
        this.jumpNear(ret + rel);
        return;
      }
      case 0xe9: {
        const rel = this.o32 ? this.fetch32() : sx16(this.fetch16());
        this.jumpNear(this.eip + rel);
        return;
      }
      case 0xea: {
        const offset = this.fetchImmV();
        const selector = this.fetch16();
        this.jumpFar(selector, offset);
        return;
      }
      case 0xeb: {
        const rel = sx8(this.fetch8());
        this.jumpNear(this.eip + rel);
        return;
      }
      case 0xec:
        this.setReg8(EAX, this.in(r[EDX] & 0xffff, 1));
        return;
      case 0xed:
        this.setRegV(EAX, this.in(r[EDX] & 0xffff, this.o32 ? 4 : 2));
        return;
      case 0xee:
        this.out(r[EDX] & 0xffff, 1, r[EAX]);
        return;
      case 0xef:
        this.out(r[EDX] & 0xffff, this.o32 ? 4 : 2, r[EAX]);
        return;
      case 0xf1:
        this.interrupt(DB, INT_EXCEPTION, -1);
        return;
      case 0xf4:
        if (this.cr0 & CR0_PE && this.cpl !== 0) this.gp(0);
        this.halted = true;
        return;
      case 0xf5:
        this.setFlag(CF, this.cf() === 0);
        return;
      case 0xf6:
      case 0xf7:
        this.group3(op);
        return;
      case 0xf8:
        this.setFlag(CF, false);
        return;
      case 0xf9:
        this.setFlag(CF, true);
        return;
      case 0xfa:
        if (this.cr0 & CR0_PE && (this.flags & VM ? this.iopl < 3 : this.cpl > this.iopl)) this.gp(0);
        this.flags &= ~IF;
        return;
      case 0xfb:
        if (this.cr0 & CR0_PE && (this.flags & VM ? this.iopl < 3 : this.cpl > this.iopl)) this.gp(0);
        if (!(this.flags & IF)) this.inhibit = true;
        this.flags |= IF;
        return;
      case 0xfc:
        this.flags &= ~DF;
        return;
      case 0xfd:
        this.flags |= DF;
        return;
      case 0xfe:
        this.decodeModrm();
        this.checkLock();
        if (this.reg === 0) this.setRm8(this.inc(this.rm8(), 7));
        else if (this.reg === 1) this.setRm8(this.dec(this.rm8(), 7));
        else this.ud();
        return;
      case 0xff:
        this.group5();
        return;
      default:
        this.ud();
    }
  }

  private enter(): void {
    const alloc = this.fetch16();
    const level = this.fetch8() & 0x1f;
    const size = this.o32 ? 4 : 2;
    const r = this.regs;
    this.pushV(r[EBP]);
    const frame = this.sp;
    let bp = this.stack32 ? r[EBP] >>> 0 : r[EBP] & 0xffff;
    if (level > 0) {
      for (let i = 1; i < level; i++) {
        bp = this.stackAddr(bp - size);
        this.pushV(size === 4 ? this.read32(SS, bp) : this.read16(SS, bp));
      }
      this.pushV(frame);
    }
    const newSp = this.stackAddr(this.sp - alloc);
    // The frame must be writable (ENTER checks the whole allocation on the 386).
    if (alloc) this.checkWriteSeg(SS, newSp, 1);
    this.setRegV(EBP, frame);
    this.setSp(newSp);
  }

  private group5(): void {
    this.decodeModrm();
    const kind = this.reg;
    if (kind <= 1) this.checkLock();
    else if (this.lock) this.ud();
    switch (kind) {
      case 0:
        this.setRmV(this.inc(this.rmV(), this.topV));
        return;
      case 1:
        this.setRmV(this.dec(this.rmV(), this.topV));
        return;
      case 2: {
        const target = this.rmV();
        this.pushV(this.eip);
        this.jumpNear(target);
        return;
      }
      case 3:
      case 5: {
        this.requireMemory();
        const offset = this.o32 ? this.read32(this.eaSeg, this.ea) : this.read16(this.eaSeg, this.ea);
        const selector = this.read16(this.eaSeg, this.eaOffset(this.o32 ? 4 : 2));
        if (kind === 3) this.callFar(selector, offset);
        else this.jumpFar(selector, offset);
        return;
      }
      case 4:
        this.jumpNear(this.rmV());
        return;
      case 6:
        this.pushV(this.rmV());
        return;
      default:
        this.ud();
    }
  }

  // --- Two-byte opcodes ------------------------------------------------------------------

  private exec0f(): void {
    const op = this.fetch8();
    const r = this.regs;
    if (this.lock && !(op === 0xab || op === 0xb3 || op === 0xbb || op === 0xba || op === 0xb0 || op === 0xb1 || op === 0xc0 || op === 0xc1 || op === 0xc7)) this.ud();
    if (op >= 0x80 && op <= 0x8f) {
      const rel = this.o32 ? this.fetch32() : sx16(this.fetch16());
      if (this.cond(op & 0xf)) this.jumpNear(this.eip + rel);
      return;
    }
    if (op >= 0x90 && op <= 0x9f) {
      this.decodeModrm();
      this.setRm8(this.cond(op & 0xf) ? 1 : 0);
      return;
    }
    if (op >= 0x40 && op <= 0x4f) {
      this.decodeModrm();
      const v = this.rmV();
      if (this.cond(op & 0xf)) this.setRegV(this.reg, v);
      return;
    }
    if (op >= 0xc8 && op <= 0xcf) {
      const v = r[op & 7];
      r[op & 7] = ((v & 0xff) << 24) | ((v & 0xff00) << 8) | ((v >>> 8) & 0xff00) | (v >>> 24);
      return;
    }
    switch (op) {
      case 0x00:
        this.group6();
        return;
      case 0x01:
        this.group7();
        return;
      case 0x02:
        this.loadAccessRights(false);
        return;
      case 0x03:
        this.loadAccessRights(true);
        return;
      case 0x06:
        this.requireCpl0();
        this.cr0 &= ~CR0_TS;
        return;
      case 0x08:
      case 0x09:
        this.requireCpl0();
        return;
      case 0x20:
      case 0x22: {
        this.requireCpl0();
        const m = this.fetch8();
        if (op === 0x20) r[m & 7] = this.readCr((m >> 3) & 7);
        else this.writeCr((m >> 3) & 7, r[m & 7]);
        return;
      }
      case 0x21:
      case 0x23: {
        this.requireCpl0();
        const m = this.fetch8();
        const n = (m >> 3) & 7;
        if (op === 0x21) r[m & 7] = this.dr[n === 4 ? 6 : n === 5 ? 7 : n];
        else this.dr[n === 4 ? 6 : n === 5 ? 7 : n] = r[m & 7];
        return;
      }
      case 0x30:
        this.wrmsr();
        return;
      case 0x31: {
        if (this.cr4 & CR4_TSD && this.cpl !== 0 && this.cr0 & CR0_PE) this.gp(0);
        const t = this.tsc;
        r[EAX] = t % 0x100000000;
        r[EDX] = Math.floor(t / 0x100000000);
        return;
      }
      case 0x32:
        this.rdmsr();
        return;
      case 0xa0:
      case 0xa8:
        this.pushV(this.sel[op === 0xa0 ? FS : GS]);
        return;
      case 0xa1:
      case 0xa9: {
        const v = this.peek(0, 2);
        this.loadSeg(op === 0xa1 ? FS : GS, v);
        this.setSp(this.sp + (this.o32 ? 4 : 2));
        return;
      }
      case 0xa2:
        this.cpuid();
        return;
      case 0xa3:
      case 0xab:
      case 0xb3:
      case 0xbb:
        this.decodeModrm();
        if (op !== 0xa3) this.checkLock();
        this.bitOp((op >> 3) & 3, this.getRegV(this.reg), true);
        return;
      case 0xba: {
        this.decodeModrm();
        if (this.reg < 4) this.ud();
        if (this.reg !== 4) this.checkLock();
        else if (this.lock) this.ud();
        this.bitOp(this.reg & 3, this.fetch8(), false);
        return;
      }
      case 0xa4:
      case 0xac: {
        this.decodeModrm();
        this.doubleShift(op === 0xa4, this.fetch8());
        return;
      }
      case 0xa5:
      case 0xad:
        this.decodeModrm();
        this.doubleShift(op === 0xa5, r[ECX]);
        return;
      case 0xaf:
        this.decodeModrm();
        this.setRegV(this.reg, this.imulTruncated(this.getRegV(this.reg), this.rmV()));
        return;
      case 0xb0: {
        this.decodeModrm();
        this.checkLock();
        this.checkRmWrite(1);
        const dest = this.rm8();
        this.alu(7, r[EAX] & 0xff, dest, 7);
        if (this.zf()) this.setRm8(this.getReg8(this.reg));
        else {
          this.setRm8(dest);
          this.setReg8(EAX, dest);
        }
        return;
      }
      case 0xb1: {
        this.decodeModrm();
        this.checkLock();
        this.checkRmWrite(this.o32 ? 4 : 2);
        const dest = this.rmV();
        this.alu(7, this.getRegV(EAX), dest, this.topV);
        if (this.zf()) this.setRmV(this.getRegV(this.reg));
        else {
          this.setRmV(dest);
          this.setRegV(EAX, dest);
        }
        return;
      }
      case 0xb2:
      case 0xb4:
      case 0xb5: {
        this.decodeModrm();
        this.requireMemory();
        const offset = this.o32 ? this.read32(this.eaSeg, this.ea) : this.read16(this.eaSeg, this.ea);
        const selector = this.read16(this.eaSeg, this.eaOffset(this.o32 ? 4 : 2));
        this.loadSeg(op === 0xb2 ? SS : op === 0xb4 ? FS : GS, selector);
        this.setRegV(this.reg, offset);
        if (op === 0xb2) this.inhibit = true;
        return;
      }
      case 0xb6:
        this.decodeModrm();
        this.setRegV(this.reg, this.rm8());
        return;
      case 0xb7:
        this.decodeModrm();
        this.setRegV(this.reg, this.rm16());
        return;
      case 0xbe:
        this.decodeModrm();
        this.setRegV(this.reg, sx8(this.rm8()));
        return;
      case 0xbf:
        this.decodeModrm();
        this.setRegV(this.reg, sx16(this.rm16()));
        return;
      case 0xbc:
      case 0xbd: {
        this.decodeModrm();
        const v = this.o32 ? this.rm32() : this.rm16();
        if (v === 0) {
          this.setResultFlags(0, 31, 0, false);
          this.lazyMask = 0;
          this.flags |= ZF;
          return;
        }
        const bit = op === 0xbc ? 31 - Math.clz32(v & -v) : 31 - Math.clz32(v);
        this.setRegV(this.reg, bit);
        this.setResultFlags(1, 31, 0, false);
        return;
      }
      case 0xc0: {
        this.decodeModrm();
        this.checkLock();
        const dest = this.rm8();
        const src = this.getReg8(this.reg);
        const sum = this.alu(0, dest, src, 7);
        this.setRm8(sum);
        this.setReg8(this.reg, dest);
        return;
      }
      case 0xc1: {
        this.decodeModrm();
        this.checkLock();
        const dest = this.rmV();
        const src = this.getRegV(this.reg);
        const sum = this.alu(0, dest, src, this.topV);
        this.checkRmWrite(this.o32 ? 4 : 2);
        this.setRmV(sum);
        this.setRegV(this.reg, dest);
        return;
      }
      case 0xc7: {
        this.decodeModrm();
        if (this.reg !== 1 || this.modrm >= 0xc0) this.ud();
        this.checkRmWrite(8);
        const lo = this.read32(this.eaSeg, this.ea);
        const hi = this.read32(this.eaSeg, this.eaOffset(4));
        if (lo === r[EAX] && hi === r[EDX]) {
          this.write32(this.eaSeg, this.ea, r[EBX]);
          this.write32(this.eaSeg, this.eaOffset(4), r[ECX]);
          this.setFlag(ZF, true);
        } else {
          this.write32(this.eaSeg, this.ea, lo);
          this.write32(this.eaSeg, this.eaOffset(4), hi);
          r[EAX] = lo;
          r[EDX] = hi;
          this.setFlag(ZF, false);
        }
        return;
      }
      default:
        this.ud();
    }
  }

  // --- For tests and the debugger ------------------------------------------------------

  /** Loads a real-mode segment register as a test or a loader would. */
  setRealSegment(seg: number, selector: number): void {
    this.setSegCache(seg, selector, selector << 4, 0xffff, 0x93);
  }

  get linearIp(): number {
    return (this.csBase + this.eip) >>> 0;
  }
}
