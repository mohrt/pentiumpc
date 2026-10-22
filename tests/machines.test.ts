import { describe, expect, it } from 'vitest';
import { FloppyImage } from '../src/chips/fdc';
import { HardDiskImage } from '../src/ide/image';
import { MACHINES } from '../src/machines';
import { bootedPc, runUntil } from './helpers/machine';

const MESSAGE = 'Sector 2 came from the floppy by DMA';

/**
 * A 1.44 MB boot floppy whose boot sector reads sector 2 with INT 13h (the floppy
 * controller, DMA channel 2 and IRQ 6) and prints the text it holds, as a setup boot disk would.
 */
function bootFloppy(): FloppyImage {
  const bytes = new Uint8Array(1474560);
  const code = [
    0xfa, // cli
    0x31, 0xc0, // xor ax, ax
    0x8e, 0xd8, // mov ds, ax
    0x8e, 0xc0, // mov es, ax
    0x8e, 0xd0, // mov ss, ax
    0xbc, 0x00, 0x7c, // mov sp, 7C00h
    0xfb, // sti
    0xbb, 0x00, 0x7e, // mov bx, 7E00h
    0xb8, 0x01, 0x02, // mov ax, 0201h: read one sector
    0xb9, 0x02, 0x00, // mov cx, 0002h: cylinder 0, sector 2
    0xb6, 0x00, // mov dh, 0 (DL is the boot drive)
    0xcd, 0x13, // int 13h
    0x72, 0x14, // jc fail
    0xbe, 0x00, 0x7e, // mov si, 7E00h
    0xac, // print: lodsb
    0x84, 0xc0, // test al, al
    0x74, 0x09, // jz done
    0xb4, 0x0e, // mov ah, 0Eh
    0xbb, 0x07, 0x00, // mov bx, 7
    0xcd, 0x10, // int 10h
    0xeb, 0xf2, // jmp print
    0xf4, // done: hlt
    0xeb, 0xfd, // jmp done
    0xb8, 0x45, 0x0e, // fail: mov ax, 0E45h ('E')
    0xcd, 0x10, // int 10h
    0xeb, 0xf6, // jmp done
  ];
  bytes.set(code);
  bytes[510] = 0x55;
  bytes[511] = 0xaa;
  bytes.set(new TextEncoder().encode(`${MESSAGE}\0`), 512);
  return new FloppyImage(bytes, 'boot.img');
}

describe('machine presets', () => {
  it('DOS and Windows 3.1: a 16 MB PC that boots from the floppy drive', () => {
    const pc = bootedPc({ config: MACHINES.dos.config, setup: (p) => p.insertFloppy(0, bootFloppy()) });
    expect(runUntil(pc, 10, () => pc.vga.screenText().includes(MESSAGE))).toBe(true);
    expect(pc.ramBytes).toBe(16 << 20);
  });

  it('Windows 95: tries the floppy drive first, and boots a setup-style boot disk from it', () => {
    const pc = bootedPc({ config: MACHINES.win95.config, setup: (p) => p.insertFloppy(0, bootFloppy()) });
    const booted = runUntil(pc, 10, () => pc.vga.screenText().includes(MESSAGE));
    if (!booted) console.log(pc.debugLog.slice(-3000), '\n---\n', pc.vga.screenText());
    expect(booted).toBe(true);
    expect(pc.ramBytes).toBe(32 << 20);
    expect(pc.debugLog).toContain('Booting from Floppy...');
  });

  it('Windows 98: tries the hard disk first, and a blank one falls through to the CD-ROM', () => {
    const pc = bootedPc({ config: MACHINES.win98.config, setup: (p) => p.attachHardDisk(HardDiskImage.blank(10)) });
    expect(runUntil(pc, 10, () => pc.vga.screenText().includes('No bootable device'))).toBe(true);
    const log = pc.debugLog;
    expect(pc.ramBytes).toBe(64 << 20);
    expect(log.indexOf('Booting from Hard Disk...')).toBeGreaterThan(-1);
    expect(log.indexOf('Booting from Hard Disk...')).toBeLessThan(log.indexOf('Booting from DVD/CD...'));
  });
});
