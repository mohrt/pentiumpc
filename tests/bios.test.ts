import { describe, expect, it } from 'vitest';
import { bootedPc, runUntil } from './helpers/machine';

describe('SeaBIOS', () => {
  it('starts, finds the hardware and reports that there is nothing to boot', () => {
    const pc = bootedPc();
    const done = runUntil(pc, 10, () => pc.vga.screenText().includes('No bootable device'));
    if (!done) console.log(pc.debugLog.slice(-4000), '\n---\n', pc.vga.screenText());
    expect(done).toBe(true);
    const log = pc.debugLog;
    expect(log).toContain('Running on QEMU (i440fx)');
    expect(log).toContain('CPU Mhz=100');
    expect(log).toContain('VBE DISPI: lfb_addr=fd000000, size 16 MB');
    expect(log).toContain('PS2 keyboard initialized');
    expect(log).toContain('DVD/CD [ata1-0: PENTIUMPC CD-ROM ATAPI-4 DVD/CD]');
    expect(log).toContain('Device reports MEDIUM NOT PRESENT');
    expect(pc.vga.screenText()).toContain('SeaBIOS (version rel-1.16.2');
  });

  it('has the network card at 300h on IRQ 9 when it is fitted, and nothing there when it is not', () => {
    const pc = bootedPc({ config: { network: true } });
    expect(runUntil(pc, 10, () => pc.vga.screenText().includes('No bootable device'))).toBe(true);
    // The address PROM, by remote DMA: the first byte of the MAC address.
    pc.out8(0x300, 0x21);
    pc.out8(0x30e, 0x48);
    pc.out8(0x308, 0);
    pc.out8(0x309, 0);
    pc.out8(0x30a, 1);
    pc.out8(0x30b, 0);
    pc.out8(0x300, 0x0a);
    expect(pc.in8(0x310)).toBe(0x52);
    // The remote DMA's end interrupt reaches IRQ 9 (the slave PIC's IRQ 1) once unmasked.
    pc.out8(0x30f, 0x40);
    expect(pc.pics.read(0xa0) & 0x02).not.toBe(0);

    pc.setConfig({ ...pc.config, network: false });
    pc.powerOn();
    expect(pc.in8(0x300)).toBe(0xff);
  });
});
