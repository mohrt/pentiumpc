import { gunzipSync } from 'node:zlib';

/** The 386 register file in MOO's order. */
export const RG32_NAMES = ['cr0', 'cr3', 'eax', 'ebx', 'ecx', 'edx', 'esi', 'edi', 'ebp', 'esp', 'cs', 'ds', 'es', 'fs', 'gs', 'ss', 'eip', 'eflags', 'dr6', 'dr7'] as const;
export type RegName = (typeof RG32_NAMES)[number];

export interface MooState {
  regs: Partial<Record<RegName, number>>;
  ram: [number, number][];
}

export interface MooTest {
  index: number;
  name: string;
  bytes: number[];
  initial: MooState;
  final: MooState;
  exception?: { number: number; flagAddress: number };
  hash: string;
}

class Reader {
  readonly data: Buffer;
  pos = 0;
  constructor(data: Buffer) {
    this.data = data;
  }
  u8(): number {
    return this.data[this.pos++];
  }
  u16(): number {
    const v = this.data.readUInt16LE(this.pos);
    this.pos += 2;
    return v;
  }
  u32(): number {
    const v = this.data.readUInt32LE(this.pos);
    this.pos += 4;
    return v;
  }
  id(): string {
    const v = this.data.toString('latin1', this.pos, this.pos + 4);
    this.pos += 4;
    return v;
  }
}

function readRegs(r: Reader, end: number): Partial<Record<RegName, number>> {
  const regs: Partial<Record<RegName, number>> = {};
  const mask = r.u32();
  for (let bit = 0; bit < RG32_NAMES.length && r.pos < end; bit++) if (mask & (1 << bit)) regs[RG32_NAMES[bit]] = r.u32();
  return regs;
}

function readState(r: Reader, end: number): MooState {
  const state: MooState = { regs: {}, ram: [] };
  while (r.pos < end) {
    const type = r.id();
    const length = r.u32();
    const next = r.pos + length;
    if (type === 'RG32') state.regs = readRegs(r, next);
    else if (type === 'RAM ') {
      const count = r.u32();
      for (let i = 0; i < count; i++) {
        const addr = r.u32();
        state.ram.push([addr, r.u8()]);
      }
    }
    r.pos = next;
  }
  return state;
}

/** Parses a (gzipped) MOO test file. */
export function parseMoo(compressed: Buffer): MooTest[] {
  const r = new Reader(gunzipSync(compressed));
  const tests: MooTest[] = [];
  while (r.pos < r.data.length) {
    const type = r.id();
    const length = r.u32();
    const next = r.pos + length;
    if (type === 'TEST') {
      const test: MooTest = { index: r.u32(), name: '', bytes: [], initial: { regs: {}, ram: [] }, final: { regs: {}, ram: [] }, hash: '' };
      while (r.pos < next) {
        const sub = r.id();
        const subLength = r.u32();
        const subNext = r.pos + subLength;
        switch (sub) {
          case 'NAME': {
            const n = r.u32();
            test.name = r.data.toString('latin1', r.pos, r.pos + n);
            break;
          }
          case 'BYTS': {
            const n = r.u32();
            test.bytes = [...r.data.subarray(r.pos, r.pos + n)];
            break;
          }
          case 'INIT':
            test.initial = readState(r, subNext);
            break;
          case 'FINA':
            test.final = readState(r, subNext);
            break;
          case 'EXCP':
            test.exception = { number: r.u8(), flagAddress: r.u32() };
            break;
          case 'HASH':
            test.hash = r.data.toString('hex', r.pos, r.pos + 20);
            break;
        }
        r.pos = subNext;
      }
      tests.push(test);
    }
    r.pos = next;
  }
  return tests;
}

export interface OpcodeInfo {
  /** The instruction has a ModR/M byte. */
  modrm: boolean;
  /** Flags the instruction leaves undefined are clear in this mask. */
  flagMask: number;
}

/** Reads 80386.csv: per opcode (and group extension, as "80.4"), whether it has a ModR/M byte and its undefined flags. */
export function parseOpcodeTable(csv: string): Map<string, OpcodeInfo> {
  const [header, ...lines] = csv.trim().split('\n');
  const columns = header.split(',');
  const at = (name: string) => columns.indexOf(name);
  const table = new Map<string, OpcodeInfo>();
  for (const line of lines) {
    const fields = line.split(',');
    const op = fields[at('op')];
    const ex = fields[at('ex')];
    const umask = fields[at('f_umask')];
    const key = ex ? `${op}.${ex}` : op;
    table.set(key, { modrm: fields[at('m')] === '1', flagMask: umask ? parseInt(umask, 16) : 0xffff });
  }
  return table;
}
