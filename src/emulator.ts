import { Pc } from './pc';

/** Longest gap caught up on, so a backgrounded tab doesn't run a burst of frames. */
const MAX_CATCH_UP_MS = 100;
/** The most host time an animation frame gives the PC, leaving the rest for the page. */
const FRAME_BUDGET_MS = 14;
/** The PC runs in steps of this much emulated time, checking the budget between them. */
const STEP_NS = 1_000_000;

/**
 * Runs the PC in step with real time, as far as the host keeps up: each animation
 * frame it runs for the time since the last one, within a budget of host time.
 * When the host is slower than the PC, emulated time simply falls behind.
 */
export class Emulator {
  /** Emulated time over real time in the last few seconds (1 is full speed). */
  speed = 1;

  constructor(readonly pc: Pc) {}

  run(elapsedMs: number): void {
    const wanted = Math.min(elapsedMs, MAX_CATCH_UP_MS) * 1e6;
    const start = this.pc.now();
    const deadline = performance.now() + FRAME_BUDGET_MS;
    while (this.pc.now() - start < wanted && performance.now() < deadline) {
      this.pc.runFor(Math.min(STEP_NS, wanted - (this.pc.now() - start)));
    }
    if (elapsedMs > 0) {
      const ratio = Math.min(1, (this.pc.now() - start) / (elapsedMs * 1e6));
      this.speed = this.speed * 0.95 + ratio * 0.05;
    }
  }
}
