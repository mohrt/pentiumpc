import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_CONFIG, Pc, type MachineConfig } from '../../src/pc';

const BIOS_DIR = join(__dirname, '..', '..', 'public', 'bios');

/** A PC with SeaBIOS (its debug build, which logs to port 402h, unless `debug` is false), switched on. */
export function bootedPc(options: { debug?: boolean; config?: Partial<MachineConfig>; setup?: (pc: Pc) => void } = {}): Pc {
  const debug = options.debug ?? true;
  const pc = new Pc({ ...DEFAULT_CONFIG, ...options.config });
  const bios = readFileSync(join(BIOS_DIR, debug ? 'seabios-debug.bin' : 'seabios.bin'));
  const vgaBios = readFileSync(join(BIOS_DIR, debug ? 'vgabios-debug.bin' : 'vgabios.bin'));
  pc.setFirmware(new Uint8Array(bios), new Uint8Array(vgaBios));
  options.setup?.(pc);
  // A fixed date, so screenshots don't change.
  pc.powerOn(Date.UTC(1999, 4, 5, 12, 0, 0) / 1000);
  return pc;
}

/** Runs until `done` is true (checked every 10 ms of emulated time) or `seconds` pass; returns whether it got there. */
export function runUntil(pc: Pc, seconds: number, done: () => boolean): boolean {
  for (let t = 0; t < seconds * 100; t++) {
    pc.runFor(10_000_000);
    if (done()) return true;
  }
  return false;
}
