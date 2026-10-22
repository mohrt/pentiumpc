import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CS, DS, EAX, EBP, EBX, ECX, EDI, EDX, ES, ESI, ESP, FS, GS, SS } from '../src/cpu/constants';
import { Cpu, type CpuHost } from '../src/cpu/cpu';
import { parseMoo, parseOpcodeTable, type MooTest, type RegName } from './helpers/moo';

const FIXTURES = join(__dirname, 'fixtures', '80386');
const available = existsSync(join(FIXTURES, '80386.csv'));
/** `X86=00,6601 npm test` runs only some files. */
const only = process.env.X86?.split(',');

class TestHost implements CpuHost {
  readonly ram = new Uint8Array(16 << 20);
  directPage(address: number): number {
    return address < this.ram.length ? address : -1;
  }
  readMemory8(): number {
    return 0xff;
  }
  writeMemory8(): void {}
  in8(): number {
    return 0xff;
  }
  in16(): number {
    return 0xffff;
  }
  in32(): number {
    return -1;
  }
  out8(): void {}
  out16(): void {}
  out32(): void {}
  acknowledgeInterrupt(): number {
    return -1;
  }
  shutdown(): void {}
  fpuError(): void {}
}

const GPRS: [RegName, number][] = [
  ['eax', EAX],
  ['ebx', EBX],
  ['ecx', ECX],
  ['edx', EDX],
  ['esi', ESI],
  ['edi', EDI],
  ['ebp', EBP],
  ['esp', ESP],
];
const SEGS: [RegName, number][] = [
  ['cs', CS],
  ['ds', DS],
  ['es', ES],
  ['fs', FS],
  ['gs', GS],
  ['ss', SS],
];
/** The flags a 386 has (no AC, VIF, VIP or ID). */
const FLAGS_386 = 0x37fd7;
/** The flags compared: the arithmetic and control flags, IOPL and NT. */
const FLAGS_COMPARED = 0x7fd7;
const PREFIXES = new Set([0x26, 0x2e, 0x36, 0x3e, 0x64, 0x65, 0x66, 0x67, 0xf0, 0xf2, 0xf3]);

/** Tests showing behaviour of the 386EX (or its test bench) that later x86 CPUs, and this emulator, don't have. */
const QUIRKS: Record<string, string> = {
  // PUSHAD wrapping past the bottom of a 16-bit stack: the 386EX writes some of the registers above the wrap before faulting.
  cfa9a2b884f6d4818ad75098bddab2a79e85cbb3: 'pushad wrap',
  '368405bf0153cdf2ab72e4e214c3fc3d53e7fe28': 'pushad wrap',
  e3dba2cf41260e669633a369786d07647fc9cf5b: 'pushad wrap',
  '0157f9b6874d8e3ac951f2d9c15e5c7a25bf4626': 'pushad wrap',
  dcdccc3287fe549d424a362423e24537e7846921: 'pushad wrap',
  '3235953e3b82fe31dbda4b77b0d08d50395ffbc1': 'pushad wrap',
  d3644a7421a5c95621496fd6a5fbfd1a04203b64: 'pushad wrap',
  '9e91448ef2fda3ec92132d7dc4a96a32588d8603': 'pushad wrap',
  // Reads of an odd port split over the 386EX's 16-bit bus, giving bits other than all ones.
  '29c9c6b39824411334d44d57db62504bb4807fc6': 'odd port read',
  ab010dbcc86182e4ce40933f61f0864ddfd38bab: 'odd port read',
  f9d9686381f6845b06163938406074037c1768a2: 'odd port read',
  c923d58b0eca0d62696e03e56c9fd46ae645bee6: 'odd port read',
  '62f9cffa058135d552793d2e2505fc93e353ffad': 'odd port read',
  '4fb5d80f331625dd650d55e8a1ab9d1da3b38784': 'odd port read',
  // String stores overwriting the instruction bytes the 386 had already prefetched.
  '83e700d32ec2f8b24b2d6868508f6f035622497a': 'prefetched code overwritten',
  '6b2abc067357767515f08c87818ee8164e3110b7': 'prefetched code overwritten',
  d8b3564f727b41848d9e0e243363bf05a45cf078: 'prefetched code overwritten',
  '82e4dc7d0031b8d567e3146c754acbad3287c3de': 'prefetched code overwritten',
  // 8-bit IDIV overflowing to a negative quotient: the 386 sometimes gives -128 instead of a divide error.
  c30147a2fb7f67459cb7a1a4c888b670edd838f5: 'idiv overflow',
  '8bddec44e46b709759d5d1550cd9fa16ab8e89fc': 'idiv overflow',
  a06745936bac371e6afb861b5bc87be4b2dd676e: 'idiv overflow',
  '8813025dcf45588bd5141eb4d7081c67d6cf3ec3': 'idiv overflow',
  c6d731127bec724d40594edc28a6ad8fdf14acbc: 'idiv overflow',
  c1392c8316c2d0532d80fb1fcb78832533093e4e: 'idiv overflow',
  b674afe8d525fdf51217456b4a3f0b9102350cc4: 'idiv overflow',
  '13e7537c7cd00f676d17da613b4289afb93b338d': 'idiv overflow',
  a4a926d8bbca1f281b0a479fd8c79fe3231bad34: 'idiv overflow',
  // The flags AAM 0 leaves as it raises the divide error.
  '6f787529179973f826f8f037d81935cddad3a0a9': 'aam 0 flags',
  '6eac1c2aae3786f4bcd060b48847126a75a5d744': 'aam 0 flags',
  c320e2d1ddd327db36854f5e0b8320cd24902bd4: 'aam 0 flags',
};

/** The opcode table's key for a test file: its name without the size prefixes. */
function opcodeKey(file: string): string {
  let key = file.replace('.MOO.gz', '');
  while (/^6[67]/.test(key) && key.length > 2 && !/^6[67](\.|$)/.test(key)) key = key.slice(2);
  return key;
}

/** Tests using a SIB byte with no index but a scale, which the 386 applies to the base (later CPUs don't). */
function hasInvalidSib(test: MooTest, modrm: boolean): boolean {
  if (!modrm) return false;
  let i = 0;
  let a32 = false;
  while (PREFIXES.has(test.bytes[i])) {
    if (test.bytes[i] === 0x67) a32 = true;
    i++;
  }
  if (test.bytes[i] === 0x0f) i++;
  i++;
  const m = test.bytes[i];
  if (!a32 || m >= 0xc0 || (m & 7) !== 4) return false;
  const sib = test.bytes[i + 1];
  return ((sib >> 3) & 7) === 4 && sib >> 6 !== 0;
}

function runTest(cpu: Cpu, host: TestHost, test: MooTest, flagMask: number): string | null {
  const init = test.initial.regs;
  cpu.reset();
  for (const [name, reg] of GPRS) cpu.regs[reg] = init[name] ?? 0;
  for (const [name, seg] of SEGS) cpu.setRealSegment(seg, (init[name] ?? 0) & 0xffff);
  cpu.eip = init.eip ?? 0;
  cpu.setEflags((init.eflags ?? 2) & FLAGS_386);
  for (const [addr, value] of test.initial.ram) host.ram[addr & 0xffffff] = value;

  for (let n = 0; n < 8 && !cpu.halted; n++) cpu.stepOne();

  const final = test.final.regs;
  const problems: string[] = [];
  const expect32 = (name: RegName, actual: number, mask = 0xffffffff) => {
    const expected = (final[name] ?? init[name] ?? 0) >>> 0;
    if (((actual ^ expected) & mask) >>> 0) problems.push(`${name} ${(actual >>> 0).toString(16)} != ${expected.toString(16)}`);
  };
  for (const [name, reg] of GPRS) expect32(name, cpu.regs[reg]);
  for (const [name, seg] of SEGS) expect32(name, cpu.sel[seg], 0xffff);
  expect32('eip', cpu.eip);
  expect32('eflags', cpu.getEflags(), FLAGS_COMPARED & flagMask);
  for (const [addr, value] of test.final.ram) {
    let mask = 0xff;
    if (test.exception && addr === test.exception.flagAddress) mask = flagMask & 0xff;
    if (test.exception && addr === test.exception.flagAddress + 1) mask = flagMask >> 8;
    const actual = host.ram[addr & 0xffffff];
    if ((actual ^ value) & mask) problems.push(`[${addr.toString(16)}] ${actual.toString(16)} != ${value.toString(16)}`);
  }
  for (const [addr] of test.initial.ram) host.ram[addr & 0xffffff] = 0;
  for (const [addr] of test.final.ram) host.ram[addr & 0xffffff] = 0;
  if (problems.length && process.env.VERBOSE) {
    const hex = (n?: number) => (n ?? 0).toString(16);
    problems.push(`initial eax=${hex(init.eax)} ecx=${hex(init.ecx)} edx=${hex(init.edx)} ebx=${hex(init.ebx)} esp=${hex(init.esp)} ebp=${hex(init.ebp)} esi=${hex(init.esi)} edi=${hex(init.edi)} ip=${hex(init.eip)} flags=${hex(init.eflags)} ss=${hex(init.ss)} cs=${hex(init.cs)}`);
    problems.push(`final ${Object.entries(final).map(([k, v]) => `${k}=${hex(v)}`).join(' ')}`);
  }
  return problems.length ? problems.join(', ') : null;
}

// Each file runs interpreted, then translated (every instruction the translator handles goes through it).
describe.skipIf(!available).each([
  ['interpreted', false],
  ['translated', true],
])('80386 SingleStepTests (real mode, %s)', (_mode, jit) => {
  if (!available) return;
  const table = parseOpcodeTable(readFileSync(join(FIXTURES, '80386.csv'), 'utf8'));
  const revoked = new Set(readFileSync(join(FIXTURES, 'revocation_list.txt'), 'utf8').split(/\s+/).filter(Boolean));
  const files = readdirSync(FIXTURES)
    .filter((name) => name.endsWith('.MOO.gz'))
    .filter((name) => !only || only.includes(name.replace('.MOO.gz', '')));
  const host = new TestHost();
  const cpu = new Cpu(host);
  cpu.jitEnabled = jit;
  cpu.jitThreshold = 1;

  it.each(files)('%s', (file) => {
    const info = table.get(opcodeKey(file)) ?? { modrm: true, flagMask: 0xffff };
    const tests = parseMoo(readFileSync(join(FIXTURES, file)));
    const failures: string[] = [];
    let ran = 0;
    for (const test of tests) {
      if (revoked.has(test.hash) || test.hash in QUIRKS || hasInvalidSib(test, info.modrm)) continue;
      ran++;
      const problem = runTest(cpu, host, test, info.flagMask);
      if (problem) failures.push(`${process.env.HASHES ? test.hash + " " : ""}#${test.index} ${test.name} [${test.bytes.map((b) => b.toString(16).padStart(2, '0')).join(' ')}]${test.exception ? ` exc ${test.exception.number}` : ''}: ${problem}`);
    }
    expect(failures.slice(0, 6).join('\n'), `${failures.length} of ${ran} failed`).toBe('');
  });
});
