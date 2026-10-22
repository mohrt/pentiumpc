// A long-running PC that can be steered from outside, for working through an installer:
// it writes .profile/<name>/screen.png and status.txt every emulated second, and reads commands
// from .profile/<name>/commands.txt (deleted once read), a line each:
//   keys Enter,Tab,KeyA     press and release keys (KeyboardEvent codes; "Alt+KeyA" holds Alt)
//   text Some words         type text
//   eject-floppy | eject-cd | quit
// The hard disk is kept in disks/<name>-hd.img.
// npx rolldown scripts/session.ts -o .profile/session.mjs --platform node && node .profile/session.mjs win98
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { FloppyImage } from '../src/chips/fdc';
import { SCANCODES } from '../src/chips/i8042';
import { CS } from '../src/cpu/constants';
import { jitOptions } from '../src/cpu/jit';
import { CdImage } from '../src/ide/ide';
import { HardDiskImage } from '../src/ide/image';
import { MACHINES } from '../src/machines';
import { Pc } from '../src/pc';
import { screenPng } from '../tests/helpers/png';

const SETUPS: Record<string, { machine: 'win95' | 'win98'; floppy?: string; cd: string; diskMb: number }> = {
  win98: { machine: 'win98', cd: 'disks/win98se.iso', diskMb: 1000 },
  win95: { machine: 'win95', floppy: 'disks/win95boot.img', cd: 'disks/win95.iso', diskMb: 500 },
};

// --dry-run: work on a copy of the disk (never saved) under .profile/<name>-dry, answering the text-mode
// setup prompts by itself and stopping after --seconds of wall time (for profiling).
const name = process.argv[2];
const setup = SETUPS[name];
const dryRun = process.argv.includes('--dry-run');
const wallLimit = Number(process.argv[process.argv.indexOf('--seconds') + 1]) || Infinity;
const AUTO_ANSWERS: [RegExp, string][] = [
  [/Enter your choice/, 'Digit2,Enter'],
  [/To continue with Setup, press ENTER/, 'Enter'],
  [/perform a routine check on your system/, 'Enter'],
];
const answered = new Set<number>();
jitOptions.interpretInBlocks = !process.argv.includes('--short-blocks');
const dir = `.profile/${name}${dryRun ? '-dry' : ''}`;
mkdirSync(dir, { recursive: true });
const diskPath = `disks/${name}-hd.img`;
const disk = existsSync(diskPath) ? HardDiskImage.fromFile(new Uint8Array(readFileSync(diskPath))) : HardDiskImage.blank(setup.diskMb);
const config = MACHINES[setup.machine].config;
const pc = new Pc(process.argv.includes('--cd-first') ? { ...config, bootOrder: ['cdrom', 'hd', 'floppy'] } : config);
pc.setFirmware(new Uint8Array(readFileSync('public/bios/seabios.bin')), new Uint8Array(readFileSync('public/bios/vgabios.bin')));
pc.attachHardDisk(disk);
pc.insertCd(new CdImage(new Uint8Array(readFileSync(setup.cd)), setup.cd));
if (setup.floppy) pc.insertFloppy(0, new FloppyImage(new Uint8Array(readFileSync(setup.floppy)), setup.floppy));
pc.powerOn(Date.UTC(1999, 4, 5, 12) / 1000);

const tap = (code: number) => {
  pc.kbc.key(code, true);
  pc.runFor(30_000_000);
  pc.kbc.key(code, false);
  pc.runFor(30_000_000);
};
const pressKey = (spec: string) => {
  const parts = spec.split('+');
  const key = parts.pop()!;
  const modifiers = parts.map((m) => SCANCODES[m === 'Alt' ? 'AltLeft' : m === 'Ctrl' ? 'ControlLeft' : m === 'Shift' ? 'ShiftLeft' : m]);
  for (const m of modifiers) {
    pc.kbc.key(m, true);
    pc.runFor(30_000_000);
  }
  if (SCANCODES[key] === undefined) throw new Error(`Unknown key ${key}`);
  tap(SCANCODES[key]);
  for (const m of modifiers.reverse()) {
    pc.kbc.key(m, false);
    pc.runFor(30_000_000);
  }
};
const typeText = (text: string) => {
  for (const ch of text) {
    if (/[A-Z]/.test(ch)) pressKey(`Shift+Key${ch}`);
    else if (/[a-z]/.test(ch)) pressKey(`Key${ch.toUpperCase()}`);
    else if (/\d/.test(ch)) pressKey(`Digit${ch}`);
    else pressKey({ ' ': 'Space', '-': 'Minus', '.': 'Period', '\\': 'Backslash', '/': 'Slash', ':': 'Shift+Semicolon', '_': 'Shift+Minus' }[ch] ?? 'Space');
  }
};

const start = performance.now();
let log = '';
pc.onReset = () => (log += `restart at ${(pc.now() / 1e9).toFixed(0)} s\n`);
for (let second = 0; ; second++) {
  for (let i = 0; i < 10; i++) pc.runFor(100_000_000);
  const commandsPath = `${dir}/commands.txt`;
  if (existsSync(commandsPath)) {
    const commands = readFileSync(commandsPath, 'utf8').split('\n').filter(Boolean);
    rmSync(commandsPath);
    for (const line of commands) {
      const [verb, ...rest] = line.split(' ');
      const arg = rest.join(' ');
      log += `> ${line}\n`;
      if (verb === 'keys') for (const key of arg.split(',')) pressKey(key.trim());
      else if (verb === 'text') typeText(arg);
      else if (verb === 'eject-floppy') pc.insertFloppy(0, null);
      else if (verb === 'eject-cd') pc.insertCd(null);
      else if (verb === 'quit') {
        if (!dryRun) writeFileSync(diskPath, disk.bytes);
        process.exit(0);
      }
    }
  }
  writeFileSync(`${dir}/screen.png`, screenPng(pc.vga));
  const text = pc.vga.screenText();
  if (dryRun) {
    AUTO_ANSWERS.forEach(([when, keys], i) => {
      if (answered.has(i) || !when.test(text)) return;
      answered.add(i);
      for (const key of keys.split(',')) pressKey(key);
    });
    if (performance.now() - start > wallLimit * 1000) {
      const mips = (pc.cpu.cycles - pc.idleCycles) / (performance.now() - start) / 1000;
      console.log(`${mips.toFixed(1)} M instructions/s, ${(pc.now() / 1e9).toFixed(0)} s emulated`);
      process.exit(0);
    }
  }
  const status = [
    `${(pc.now() / 1e9).toFixed(0)} s emulated, ${((performance.now() - start) / 1000).toFixed(0)} s wall`,
    `${pc.vga.width}x${pc.vga.height} ${text ? 'text' : 'graphics'}, cs:eip ${pc.cpu.sel[CS].toString(16)}:${(pc.cpu.eip >>> 0).toString(16)}${pc.cpu.halted ? ' halted' : ''}, disk ${pc.ide[0].active ? 'busy' : 'idle'}`,
    log,
    text,
  ].join('\n');
  writeFileSync(`${dir}/status.txt`, status);
  if (!dryRun && second % 30 === 29 && disk.dirty.size) {
    writeFileSync(diskPath, disk.bytes);
    disk.dirty.clear();
  }
}
