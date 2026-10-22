// Register numbers, as instructions encode them.
export const EAX = 0;
export const ECX = 1;
export const EDX = 2;
export const EBX = 3;
export const ESP = 4;
export const EBP = 5;
export const ESI = 6;
export const EDI = 7;

// Segment registers, as instructions encode them.
export const ES = 0;
export const CS = 1;
export const SS = 2;
export const DS = 3;
export const FS = 4;
export const GS = 5;

// EFLAGS bits.
export const CF = 0x0001;
export const PF = 0x0004;
export const AF = 0x0010;
export const ZF = 0x0040;
export const SF = 0x0080;
export const TF = 0x0100;
export const IF = 0x0200;
export const DF = 0x0400;
export const OF = 0x0800;
export const IOPL = 0x3000;
export const NT = 0x4000;
export const RF = 0x10000;
export const VM = 0x20000;
export const AC = 0x40000;
export const VIF = 0x80000;
export const VIP = 0x100000;
export const ID = 0x200000;
/** The six flags arithmetic sets. */
export const ARITH_FLAGS = CF | PF | AF | ZF | SF | OF;
/** Flags software can change at all (bit 1 always reads as 1). */
export const EFLAGS_MASK = ARITH_FLAGS | TF | IF | DF | IOPL | NT | RF | VM | AC | VIF | VIP | ID;

// CR0 bits.
export const CR0_PE = 1 << 0;
export const CR0_MP = 1 << 1;
export const CR0_EM = 1 << 2;
export const CR0_TS = 1 << 3;
export const CR0_ET = 1 << 4;
export const CR0_NE = 1 << 5;
export const CR0_WP = 1 << 16;
export const CR0_AM = 1 << 18;
export const CR0_PG = 1 << 31;

// CR4 bits.
export const CR4_TSD = 1 << 2;
export const CR4_PSE = 1 << 4;

// Exceptions.
export const DE = 0;
export const DB = 1;
export const BP = 3;
export const OVERFLOW = 4;
export const BR = 5;
export const UD = 6;
export const NM = 7;
export const DOUBLE_FAULT = 8;
export const TS = 10;
export const NP = 11;
export const SS_FAULT = 12;
export const GP = 13;
export const PAGE_FAULT = 14;
export const MF = 16;
