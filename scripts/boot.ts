// Boots a disk image and shows the screen as it goes, for trying operating systems by hand.
// npx rolldown scripts/boot.ts -o .profile/boot.mjs --platform node && node .profile/boot.mjs disks/kolibri.img 20
import { readFileSync, writeFileSync } from 'node:fs';
import { screenPng } from '../tests/helpers/png';
import { FloppyImage } from '../src/chips/fdc';
import { SCANCODES } from '../src/chips/i8042';
import { CS } from '../src/cpu/constants';
import { CdImage } from '../src/ide/ide';
import { HardDiskImage } from '../src/ide/image';
import { DEFAULT_CONFIG, Pc } from '../src/pc';

// Arguments: one or more images (the first is booted), keys to type as "@<second>=<Key>,<Key>..."
// (KeyboardEvent codes, or text in quotes after "text:"), then the seconds to run.
const args = process.argv.slice(2);
const typing: { at: number; keys: string[] }[] = [];
for (let i = args.length - 1; i >= 0; i--) {
  const match = /^@([\d.]+)=(.*)$/.exec(args[i]);
  if (!match) continue;
  args.splice(i, 1);
  const keys = match[2].startsWith('text:') ? [...match[2].slice(5)].map(charCode) : match[2].split(',');
  typing.push({ at: Number(match[1]), keys });
}

/** The key code that types a character (letters, digits, space and a few marks). */
function charCode(ch: string): string {
  if (/[a-z]/i.test(ch)) return `Key${ch.toUpperCase()}`;
  if (/\d/.test(ch)) return `Digit${ch}`;
  return { ' ': 'Space', '-': 'Minus', '.': 'Period', '\\': 'Backslash', ':': 'Semicolon' }[ch] ?? 'Space';
}
const seconds = /^\d+$/.test(args[args.length - 1]) ? Number(args.pop()) : 20;
const path = args[0];
type Kind = 'cdrom' | 'floppy' | 'hd';
const media = args.map((file) => {
  const bytes = new Uint8Array(readFileSync(file));
  const kind: Kind = file.endsWith('.iso') ? 'cdrom' : bytes.length <= 2949120 ? 'floppy' : 'hd';
  return { file, bytes, kind };
});
const order = [media[0].kind, 'hd', 'cdrom', 'floppy'].filter((d, i, all) => all.indexOf(d) === i) as Kind[];
const pc = new Pc({ ...DEFAULT_CONFIG, bootOrder: order });
pc.setFirmware(new Uint8Array(readFileSync('public/bios/seabios.bin')), new Uint8Array(readFileSync('public/bios/vgabios.bin')));
for (const { file, bytes, kind } of media) {
  if (kind === 'cdrom') pc.insertCd(new CdImage(bytes, file));
  else if (kind === 'floppy') pc.insertFloppy(0, new FloppyImage(bytes, file));
  else pc.attachHardDisk(HardDiskImage.fromFile(bytes));
}
if (!media.some((m) => m.kind === 'hd')) pc.attachHardDisk(HardDiskImage.blank(500));
pc.powerOn(Date.UTC(1999, 4, 5) / 1000);

const exceptions = new Map<string, number>();
const cpu = pc.cpu;
cpu.onException = (vector, code) => {
  const key = `#${vector}(${code.toString(16)}) at ${cpu.sel[CS].toString(16)}:${(cpu.eip >>> 0).toString(16)}`;
  exceptions.set(key, (exceptions.get(key) ?? 0) + 1);
};
const start = performance.now();
let last = '';
for (let i = 0; i < seconds * 10; i++) {
  for (const { at, keys } of typing) {
    if (Math.round(at * 10) !== i) continue;
    for (const key of keys) {
      const code = SCANCODES[key];
      if (code === undefined) throw new Error(`Unknown key ${key}`);
      pc.kbc.key(code, true);
      pc.runFor(30_000_000);
      pc.kbc.key(code, false);
      pc.runFor(30_000_000);
    }
  }
  const c0 = cpu.cycles;
  const t0 = performance.now();
  pc.runFor(100_000_000);
  const mips = (cpu.cycles - c0) / (performance.now() - t0) / 1000;
  pc.vga.render();
  const text = pc.vga.screenText().split('\n').filter(Boolean).slice(-8).join('\n');
  const mode = `${pc.vga.width}x${pc.vga.height}${pc.vga.screenText() ? ' text' : ' graphics'}`;
  const state = `[${((i + 1) / 10).toFixed(1)}s emulated, ${((performance.now() - start) / 1000).toFixed(0)}s wall, ${mips.toFixed(0)} MIPS, ${mode}, cr0=${cpu.cr0.toString(16)} cs:eip=${cpu.sel[CS].toString(16)}:${(cpu.eip >>> 0).toString(16)}${cpu.halted ? ' halted' : ''}]`;
  if (text !== last || i % 20 === 19) console.log(`${state}\n${text !== last ? text : ''}`);
  last = text;
}
const shot = `.profile/${path.split('/').pop()}.png`;
writeFileSync(shot, screenPng(pc.vga));
console.log(`screenshot: ${shot}`);
const top = [...exceptions].sort((a, b) => b[1] - a[1]).slice(0, 10);
console.log('exceptions:', top.map(([k, n]) => `${k} x${n}`).join('; ') || 'none');
