# Windows 95 and 98 PC in the browser

A late-1990s Pentium PC emulated from scratch in TypeScript, for running Windows 95 and Windows 98 (and DOS, and Windows 3.1 on DOS). The emulator is still being built: the machine boots, but the page around it isn't there yet.

- **CPU:** an x86 with the 386's real, protected and virtual 8086 modes and paging, the 486's additions and the Pentium's CPUID, RDTSC, MSRs and CMPXCHG8B, with an x87 FPU. It passes all 941 files of Daniel Balsom's real-mode SingleStepTests for the 80386, captured from a 386EX; the few tests that show quirks of that chip are listed in `tests/cpu386.test.ts` with the reason for each.
- **Chipset:** an i440FX with a PIIX3: two 8259 PICs, an 8254 timer, two 8237 DMA controllers, the RTC and CMOS, PCI configuration and the A20 gate.
- **Devices:** an 8042 with a PS/2 keyboard and wheel mouse, a floppy controller (360K to 2.88 MB disks), an IDE hard disk and an ATAPI CD-ROM drive, and a VGA with the Bochs VBE extension (up to 1600 x 1200 in true colour, with a linear frame buffer).
- **Firmware:** SeaBIOS 1.16.2 and SeaVGABIOS, as the v86 project builds them, in `public/bios/` (LGPL 3, sources at [seabios.org](https://www.seabios.org/)).

## Windows 95 and Windows 98

Both run on the same PC. Machine setup will offer a preset for each (`src/machines.ts`):

| | Memory | Boots from | New hard disk |
|---|---|---|---|
| Windows 95 | 32 MB | floppy, hard disk, CD-ROM | 500 MB |
| Windows 98 | 64 MB | hard disk, CD-ROM, floppy | 2 GB |

Windows is never included or served. Load your own installation CD (an `.iso`), boot floppy (`.img`) or a hard disk image with Windows already installed; they stay in your browser.

- **Installing Windows 95:** its CD isn't bootable, so start from a Windows 95 boot floppy with CD-ROM support (the startup disk Windows 95 makes, or one of the widely shared boot disks), then run `SETUP` from the CD. The original release partitions with FAT16, so keep the disk under 2 GB; OSR2 (95B and C) can use FAT32.
- **Installing Windows 98:** create a blank hard disk and insert the CD. The blank disk can't boot, so the PC falls through to the CD, whose menu starts setup. Once Windows is installed it starts from the hard disk.
- **Graphics:** neither version has a driver for this graphics card, so both start in 640 x 480 with 16 colours. A VESA driver such as VBEMP 9x gives high colour and larger screens.

## Development

```sh
npm install
npm test                    # tests needing downloaded files skip when they're missing
npm run fetch:386           # optional: the 80386 SingleStepTests (about 580 MB)
npm run fetch:test-disks    # optional: a FreeDOS hard disk image for the boot tests
npm run fetch:bios          # downloads SeaBIOS again (the copies in public/bios are committed)
```

`DEBUG_BOOT=1 npx vitest run tests/debug.test.ts --disableConsoleIntercept` traces a boot. The tests use SeaBIOS's debug build, which writes its log to port 402h.
