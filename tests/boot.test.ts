import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FloppyImage } from '../src/chips/fdc';
import { SCANCODES } from '../src/chips/i8042';
import { CdImage } from '../src/ide/ide';
import { HardDiskImage } from '../src/ide/image';
import { MACHINES } from '../src/machines';
import type { Pc } from '../src/pc';
import { bootedPc, runUntil } from './helpers/machine';

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
});
