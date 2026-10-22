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
});
