# Pentium PC in the browser

A late-1990s Pentium PC emulated from scratch in TypeScript, running in a web page. It emulates the hardware, not any one operating system: install Windows 95 or Windows 98 from your own CD, or run DOS, Windows 3.1, FreeDOS and the other PC systems of the time. Its hard disk is kept in your browser, and with a relay it can go on the internet.

- **CPU:** an x86 with the 386's real, protected and virtual 8086 modes and paging, the 486's additions and the Pentium's CPUID, RDTSC, MSRs and CMPXCHG8B, with an x87 FPU. Code that runs often is translated into JavaScript functions, which runs it about twice as fast as interpreting it. It passes all 941 files of Daniel Balsom's real-mode SingleStepTests for the 80386, captured from a 386EX, both interpreted and translated; the few tests that show quirks of that chip are listed in `tests/cpu386.test.ts` with the reason for each.
- **Chipset:** an i440FX with a PIIX3: two 8259 PICs, an 8254 timer, two 8237 DMA controllers, the RTC and CMOS, PCI configuration and the A20 gate.
- **Devices:** an 8042 with a PS/2 keyboard and wheel mouse, a floppy controller (360K to 2.88 MB disks), an IDE hard disk and an ATAPI CD-ROM drive, a VGA with the Bochs VBE extension (up to 1600 x 1200 in true colour, with a linear frame buffer), and, when a network relay is set, an NE2000-compatible network card on the ISA bus (I/O port 300h, IRQ 9).
- **Firmware:** SeaBIOS 1.16.2 and SeaVGABIOS, as the v86 project builds them, in `public/bios/` (LGPL 3, sources at [seabios.org](https://www.seabios.org/)).

## What runs on it

Machine setup offers a preset for each kind of system (`src/machines.ts`); they are the same PC, set up the way each system wants it, and each keeps its own hard disk:

| | Memory | Boots from | New hard disk |
|---|---|---|---|
| DOS and Windows 3.1 | 16 MB | floppy, hard disk, CD-ROM | 500 MB |
| Windows 95 | 32 MB | floppy, hard disk, CD-ROM | 500 MB |
| Windows 98 | 64 MB | hard disk, CD-ROM, floppy | 2 GB |

No operating system is included or served except the firmware. Load your own installation disks: a CD (`.iso`), floppies (`.img`, `.ima`), or a hard disk image with a system already installed. They stay in your browser.

- **DOS and Windows 3.1:** boot the first DOS installation floppy, let its setup partition and format the hard disk, and swap in the other disks as it asks. Then run Windows 3.1's `SETUP` from its first floppy.
- **Windows 95:** its CD isn't bootable, so start from a Windows 95 boot floppy with CD-ROM support (the startup disk Windows 95 makes, or a shared boot disk), then run `SETUP` from the CD. The original release partitions with FAT16, so keep the disk under 2 GB; OSR2 (95B and C) can use FAT32.
- **Windows 98:** create a blank hard disk and insert the CD. The blank disk can't boot, so the PC falls through to the CD, whose menu starts setup; choose *Boot from CD-ROM*. Once Windows is installed it starts from the hard disk.
- **Other systems:** FreeDOS, KolibriOS and Linux distributions of the time boot from their own floppies, CDs or disk images.

### Not yet tested or supported: Windows NT, 2000 and XP

These may be possible, but none has been tried, so expect problems. Notes on what they need:

- **Windows NT 4.0** is the most likely to work: it supports a Pentium with IDE, VGA and a PS/2 mouse, boots from its CD, and has a driver for the NE2000 network card. It uses protected mode, paging and task switching far more strictly than Windows 98, so it may show up CPU bugs that Windows 98 doesn't.
- **Windows 2000** needs more memory (64 MB or more) and is slower. The PC has no ACPI power management, so it would have to be installed as a *Standard PC* (press F5 when setup asks about a SCSI or RAID driver, to choose the computer type).
- **Windows XP** asks for a 233 MHz processor and 64 MB at least (128 MB is better), and the same *Standard PC* installation. It doesn't need MMX or SSE, which this CPU lacks. The emulator runs like a Pentium of about 90 to 100 MHz at best, so XP's setup would take hours and the desktop would be slow. Its 1.5 GB of files need a bigger disk than the presets make; import a larger blank image (up to 8 GB).

None of them has a machine preset yet. Use the Windows 98 one (hard disk, then CD) with more memory.
- **Graphics:** Windows has no driver for this graphics card, so Windows 3.1, 95 and 98 start in 640 x 480 with 16 colours. A VESA driver such as VBEMP 9x gives Windows 95 and 98 high colour and larger screens.

## Using the page

- **Disks:** drop files anywhere on the page, or use the drive buttons. A CD image (`.iso`) goes in the CD-ROM drive and a floppy image (`.img`, `.ima`, `.vfd`, up to 2.88 MB) in drive A:. A larger `.img`, or a disk image from another emulator or virtual machine, can become the hard disk: VHD (Virtual PC, Hyper-V; fixed or dynamic), VMDK (VMware; monolithic sparse, or the `-flat.vmdk` of a flat disk), VDI (VirtualBox) and qcow2 (QEMU, uncompressed). Others, such as compressed or split images, can be converted first with `qemu-img convert -O raw <file> disk.img`. A system installed on other hardware finds new devices on its first start here and may ask for its CD for their drivers.
- **The hard disk** is saved in the browser (IndexedDB) a few seconds after programs write to it. Machine setup makes a new empty disk, imports an image, exports the disk as a raw `.img` (keep a copy: clearing the site's data deletes it) and deletes it.
- **Keyboard and mouse:** click the screen to type and use the mouse; Esc lets the mouse go. Ctrl+Alt+Del is on the toolbar, since your own computer keeps it.
- **Network:** set a relay in machine setup and the PC gets a network card. [NETWORKING.md](NETWORKING.md) explains how, with a ready-made relay for Docker in [`relay/`](relay/) that also lets Windows 98's browser open today's https sites.

## Development

```sh
npm install
npm run dev                 # the page at http://localhost:5173/
npm test                    # tests needing downloaded files or your own images skip when they're missing
npm run fetch:386           # optional: the 80386 SingleStepTests (about 580 MB)
npm run fetch:test-disks    # optional: FreeDOS 1.2, ReactOS 0.4.15, Tiny Core Linux 15 and KolibriOS
npm run fetch:bios          # downloads SeaBIOS again (the copies in public/bios are committed)
```

`tests/boot.test.ts` boots KolibriOS to its desktop and, when you put your own images in `disks/` (never committed), takes Windows 95 (`win95boot.img` with `win95.iso`) and Windows 98 (`win98se.iso`) to their setup screens. The tests use SeaBIOS's debug build, which writes its log to port 402h; `DEBUG_BOOT=1 npx vitest run tests/debug.test.ts --disableConsoleIntercept` traces a boot.

Some scripts help outside the tests; bundle them with `npx rolldown scripts/<name>.ts -o .profile/<name>.mjs --platform node`, then run them with node:

- `boot.ts`: boots images (`node .profile/boot.mjs disks/win95boot.img disks/win95.iso @5=Enter 60`), printing the screen and saving a screenshot.
- `session.ts`: a long-running PC for working through an installer, steered by commands written to `.profile/<name>/commands.txt`; the hard disk is kept in `disks/<name>-hd.img`. `node scripts/watch.mjs <name>` shows it at http://127.0.0.1:8098/ and sends it the keys typed there.
- `bench.ts` and `cpu-bench.ts`: the emulator's speed on FreeDOS's boot and on small loops.
- `make-disk-format-fixtures.ts`: remakes `tests/fixtures/disk-formats` with qemu-img in Docker.
