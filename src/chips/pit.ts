/** The PIT's input clock: 1.193182 MHz. */
export const PIT_HZ = 1193182;
const NS_PER_SECOND = 1e9;

/** Emulated time in nanoseconds. */
export interface Clock {
  now(): number;
}

class Channel {
  /** The reload value (0 means 65536). */
  count = 0x10000;
  latchedCount = 0;
  latchedCountBytes = 0;
  status = 0;
  statusLatched = false;
  readState = 3;
  writeState = 3;
  writeLatch = 0;
  rwMode = 3;
  mode = 0;
  bcd = false;
  gate = false;
  /** When the counter was last loaded (ns). */
  loadTime = 0;
  /** Whether a count has been written since the mode was set (the counter runs only once it has). */
  armed = false;
}

/**
 * The 8254 programmable interval timer: channel 0 drives IRQ 0, channel 2
 * the PC speaker and port 61h's OUT2 bit. Counters are worked out from the
 * time since they were loaded rather than stepped.
 */
export class Pit {
  readonly channels = [new Channel(), new Channel(), new Channel()];
  /** When channel 0's output next rises (raising IRQ 0), or Infinity. */
  nextIrq = Infinity;
  onIrq: () => void = () => {};
  /** Channel 2's settings changed (for the speaker's sound). */
  onSpeakerChange: () => void = () => {};

  constructor(private readonly clock: Clock) {
    this.reset();
  }

  reset(): void {
    this.channels.forEach((c, i) => {
      c.mode = 3;
      c.count = 0x10000;
      c.gate = i !== 2;
      c.loadTime = this.clock.now();
      c.armed = false;
      c.rwMode = 3;
      c.readState = c.writeState = 3;
      c.statusLatched = false;
      c.latchedCountBytes = 0;
    });
    this.nextIrq = Infinity;
  }

  private ticks(c: Channel, now: number): number {
    return Math.floor(((now - c.loadTime) * PIT_HZ) / NS_PER_SECOND);
  }

  private currentCount(c: Channel): number {
    const d = this.ticks(c, this.clock.now());
    switch (c.mode) {
      case 0:
      case 1:
      case 4:
      case 5:
        return (c.count - d) & 0xffff;
      case 3:
        return (c.count - ((2 * d) % c.count)) & 0xfffe;
      default:
        return c.count - (d % c.count);
    }
  }

  /** A channel's output at `now`. */
  output(index: number, now = this.clock.now()): boolean {
    const c = this.channels[index];
    if (!c.armed) return c.mode !== 0;
    const d = this.ticks(c, now);
    switch (c.mode) {
      case 0:
        return d >= c.count;
      case 1:
        return d < c.count;
      case 2:
        return d % c.count !== c.count - 1;
      case 3:
        return d % c.count < (c.count + 1) >> 1;
      default:
        return d !== c.count;
    }
  }

  /** The frequency channel 2 is producing (for the speaker), or 0 if it isn't a square wave. */
  get speakerHz(): number {
    const c = this.channels[2];
    if (!c.armed || !c.gate || (c.mode !== 3 && c.mode !== 2)) return 0;
    return PIT_HZ / c.count;
  }

  /** Works out when channel 0 next raises IRQ 0. */
  private scheduleIrq(): void {
    const c = this.channels[0];
    if (!c.armed || !c.gate) {
      this.nextIrq = Infinity;
      return;
    }
    const now = this.clock.now();
    const d = this.ticks(c, now);
    let next: number;
    switch (c.mode) {
      case 0:
      case 4:
        next = d < c.count ? c.count : -1;
        break;
      case 2:
      case 3:
        next = (Math.floor(d / c.count) + 1) * c.count;
        break;
      default:
        next = -1;
    }
    this.nextIrq = next < 0 ? Infinity : c.loadTime + (next * NS_PER_SECOND) / PIT_HZ;
  }

  /** Raises IRQ 0 if channel 0's time has come. */
  update(now: number): void {
    if (now < this.nextIrq) return;
    this.onIrq();
    const c = this.channels[0];
    if (c.mode === 2 || c.mode === 3) {
      const period = (c.count * NS_PER_SECOND) / PIT_HZ;
      this.nextIrq += period;
      // A long gap (the machine was paused) shouldn't replay every tick.
      if (this.nextIrq < now) this.nextIrq = now + period;
    } else {
      this.nextIrq = Infinity;
    }
  }

  private load(index: number, value: number): void {
    const c = this.channels[index];
    c.count = value === 0 ? 0x10000 : value;
    c.loadTime = this.clock.now();
    c.armed = true;
    if (index === 0) this.scheduleIrq();
    if (index === 2) this.onSpeakerChange();
  }

  private latchCount(c: Channel): void {
    if (c.latchedCountBytes) return;
    c.latchedCount = this.currentCount(c);
    c.latchedCountBytes = c.rwMode === 3 ? 2 : 1;
    c.readState = c.rwMode;
  }

  setGate(index: number, gate: boolean): void {
    const c = this.channels[index];
    if (gate && !c.gate && (c.mode === 1 || c.mode === 5 || c.mode === 2 || c.mode === 3)) {
      // A rising gate restarts the count.
      c.loadTime = this.clock.now();
    }
    c.gate = gate;
    if (index === 0) this.scheduleIrq();
    if (index === 2) this.onSpeakerChange();
  }

  write(port: number, value: number): void {
    const index = port & 3;
    if (index === 3) {
      const channel = value >> 6;
      if (channel === 3) {
        // Read-back command.
        for (let i = 0; i < 3; i++) {
          if (!(value & (2 << i))) continue;
          const c = this.channels[i];
          if (!(value & 0x20)) this.latchCount(c);
          if (!(value & 0x10) && !c.statusLatched) {
            c.status = (this.output(i) ? 0x80 : 0) | (c.rwMode << 4) | (c.mode << 1) | (c.bcd ? 1 : 0);
            c.statusLatched = true;
          }
        }
        return;
      }
      const c = this.channels[channel];
      const rw = (value >> 4) & 3;
      if (rw === 0) {
        this.latchCount(c);
        return;
      }
      c.rwMode = rw;
      c.readState = c.writeState = rw;
      c.mode = (value >> 1) & 7;
      if (c.mode > 5) c.mode -= 4;
      c.bcd = (value & 1) !== 0;
      c.armed = false;
      if (channel === 0) this.scheduleIrq();
      if (channel === 2) this.onSpeakerChange();
      return;
    }
    const c = this.channels[index];
    switch (c.writeState) {
      case 1:
        this.load(index, value);
        break;
      case 2:
        this.load(index, value << 8);
        break;
      case 3:
        c.writeLatch = value;
        c.writeState = 4;
        break;
      default:
        this.load(index, c.writeLatch | (value << 8));
        c.writeState = 3;
    }
  }

  read(port: number): number {
    const c = this.channels[port & 3];
    if (c.statusLatched) {
      c.statusLatched = false;
      return c.status;
    }
    if (c.latchedCountBytes) {
      let value: number;
      if (c.readState === 3) {
        value = c.latchedCount & 0xff;
        c.readState = 4;
        c.latchedCountBytes--;
        return value;
      }
      value = c.readState === 1 ? c.latchedCount & 0xff : (c.latchedCount >> 8) & 0xff;
      c.latchedCountBytes = 0;
      c.readState = c.rwMode;
      return value;
    }
    const count = this.currentCount(c);
    switch (c.readState) {
      case 1:
        return count & 0xff;
      case 2:
        return (count >> 8) & 0xff;
      case 3:
        c.readState = 4;
        return count & 0xff;
      default:
        c.readState = 3;
        return (count >> 8) & 0xff;
    }
  }
}
