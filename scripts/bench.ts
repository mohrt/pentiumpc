// Measures how fast the emulator runs FreeDOS's boot (disks/freedos12.img, from npm run fetch:test-disks).
// Bundle and run with: npx rolldown scripts/bench.ts -o /tmp/bench.mjs --platform node && node /tmp/bench.mjs
import { readFileSync } from 'node:fs';
import { HardDiskImage } from '../src/ide/image';
import { DEFAULT_CONFIG, Pc } from '../src/pc';

const seconds = Number(process.argv[2] ?? 4);
const pc = new Pc({ ...DEFAULT_CONFIG, bootOrder: ['hd'] });
pc.setFirmware(new Uint8Array(readFileSync('public/bios/seabios.bin')), new Uint8Array(readFileSync('public/bios/vgabios.bin')));
pc.attachHardDisk(HardDiskImage.fromFile(new Uint8Array(readFileSync('disks/freedos12.img'))));
pc.powerOn(Date.UTC(1999, 4, 5) / 1000);
const start = performance.now();
const startCycles = pc.cpu.cycles;
for (let i = 0; i < seconds * 100; i++) pc.runFor(10_000_000);
const wall = (performance.now() - start) / 1000;
const cycles = pc.cpu.cycles - startCycles;
console.log(`${seconds} s emulated in ${wall.toFixed(2)} s: ${(cycles / wall / 1e6).toFixed(1)} M instructions/s`);
console.log(pc.vga.screenText().split('\n').filter(Boolean).slice(-6).join('\n'));
