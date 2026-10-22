import { it } from 'vitest';
import { bootedPc } from './helpers/machine';

it.skipIf(!process.env.DEBUG_BOOT)('debug boot', () => {
  const pc = bootedPc();
  const start = performance.now();
  let lastLog = 0;
  for (let i = 0; i < 300; i++) {
    const c0 = pc.cpu.cycles;
    const t0 = performance.now();
    pc.runFor(10_000_000);
    const wall = performance.now() - t0;
    if (pc.debugLog.length !== lastLog) {
      console.log(`[${(pc.now() / 1e6).toFixed(0)}ms emulated, ${(performance.now() - start).toFixed(0)}ms wall, ${((pc.cpu.cycles - c0) / wall / 1000).toFixed(1)} MIPS] ${pc.debugLog.slice(lastLog).trimEnd()}`);
      lastLog = pc.debugLog.length;
    }
    if (pc.vga.screenText().includes('No bootable device')) break;
  }
  console.log(pc.vga.screenText());
});
