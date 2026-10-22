import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FloppyImage } from '../src/chips/fdc';
import { SCANCODES } from '../src/chips/i8042';
import { CdImage } from '../src/ide/ide';
import { HardDiskImage } from '../src/ide/image';
import { MACHINES } from '../src/machines';
import type { Pc } from '../src/pc';
import { bootedPc, runUntil } from './helpers/machine';
import { screenPng } from './helpers/png';

// Operating systems booted from disks/: the free ones come from `npm run fetch:test-disks`;
// Windows images are your own (win95boot.img with win95.iso, and win98se.iso).
const DISKS = join(__dirname, '..', 'disks');
const disk = (name: string) => join(DISKS, name);
const have = (...names: string[]) => names.every((name) => existsSync(disk(name)));
const load = (name: string) => new Uint8Array(readFileSync(disk(name)));

function press(pc: Pc, key: string): void {
  pc.kbc.key(SCANCODES[key], true);
  pc.runFor(30_000_000);
  pc.kbc.key(SCANCODES[key], false);
  pc.runFor(30_000_000);
}

/** Whether the screen shows many colours (a graphical desktop rather than a blank or text screen). */
function colourful(pc: Pc): boolean {
  pc.vga.render();
  const colours = new Set<number>();
  const { framebuffer, width, height } = pc.vga;
  for (let i = 0; i < width * height; i += 97) colours.add(framebuffer[i]);
  return colours.size > 40;
}

describe('booting operating systems', () => {
  it.skipIf(!have('kolibri.img'))('KolibriOS starts its desktop in 1024 x 768 from its boot floppy', { timeout: 240_000 }, () => {
    const pc = bootedPc({ debug: false, config: MACHINES.win95.config, setup: (p) => p.insertFloppy(0, new FloppyImage(load('kolibri.img'), 'kolibri.img')) });
    const started = runUntil(pc, 20, () => (pc.cpu.cr0 & 0x80000000) !== 0 && colourful(pc) && pc.vga.width === 1024);
    expect(started).toBe(true);
    expect(pc.vga.height).toBe(768);
  });

  it.skipIf(!have('win95boot.img', 'win95.iso'))('Windows 95: the boot floppy starts setup from the CD', { timeout: 240_000 }, () => {
    const pc = bootedPc({
      debug: false,
      config: MACHINES.win95.config,
      setup: (p) => {
        p.insertFloppy(0, new FloppyImage(load('win95boot.img'), 'win95boot.img'));
        p.insertCd(new CdImage(load('win95.iso'), 'win95.iso'));
        p.attachHardDisk(HardDiskImage.blank(MACHINES.win95.newDiskMb));
      },
    });
    expect(runUntil(pc, 30, () => pc.vga.screenText().includes('To continue with Setup, press ENTER'))).toBe(true);
  });

  it.skipIf(!have('win98se.iso'))('Windows 98: a blank disk falls through to the CD, whose menu starts setup', { timeout: 600_000 }, () => {
    const pc = bootedPc({
      debug: false,
      config: MACHINES.win98.config,
      setup: (p) => {
        p.insertCd(new CdImage(load('win98se.iso'), 'win98se.iso'));
        p.attachHardDisk(HardDiskImage.blank(MACHINES.win98.newDiskMb));
      },
    });
    expect(runUntil(pc, 10, () => pc.vga.screenText().includes('Microsoft Windows 98 CD-ROM Startup Menu'))).toBe(true);
    press(pc, 'Digit2');
    press(pc, 'Enter');
    expect(runUntil(pc, 60, () => pc.vga.screenText().includes('To continue with Setup, press ENTER'))).toBe(true);
    expect(pc.vga.screenText()).toContain('Microsoft Windows 98 Setup');
  });

  // win98se-installed.img: a copy of a hard disk Windows 98 SE was installed on in this PC.
  it.skipIf(!have('win98se-installed.img'))('Windows 98: an installed disk starts the desktop', { timeout: 1_200_000 }, () => {
    const pc = bootedPc({
      debug: false,
      config: MACHINES.win98.config,
      setup: (p) => {
        p.attachHardDisk(HardDiskImage.fromFile(load('win98se-installed.img')));
        // Interpreted: with translated blocks, Windows 98 hangs as it starts (a translation bug not yet found).
        p.cpu.jitEnabled = false;
      },
    });
    const rgb = (x: number, y: number) => {
      const pixel = pc.vga.framebuffer[y * pc.vga.width + x];
      return [pixel & 0xff, (pixel >> 8) & 0xff, (pixel >> 16) & 0xff];
    };
    // The desktop's teal background, with the light grey taskbar along the bottom (looked for every half second);
    // the shades depend on the palette Windows' display driver sets.
    const teal = ([r, g, b]: number[]) => g > r + 0x30 && Math.abs(g - b) < 0x10;
    const grey = ([r, g, b]: number[]) => r > 0xa0 && Math.max(r, g, b) - Math.min(r, g, b) < 0x10;
    let checks = 0;
    const desktop = () => {
      if (++checks % 50) return false;
      pc.vga.render();
      return pc.vga.width === 640 && pc.vga.height === 480 && teal(rgb(600, 240)) && grey(rgb(320, 470));
    };
    const started = runUntil(pc, 180, desktop);
    if (!started) {
      const dir = join(__dirname, '..', '.profile');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'win98-desktop-test.png'), screenPng(pc.vga));
    }
    expect(started).toBe(true);
  });
});
