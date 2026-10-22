import type { Clock } from './pit';

const REG_A = 0x0a;
const REG_B = 0x0b;
const REG_C = 0x0c;
const REG_D = 0x0d;
const B_SET = 0x80;
const B_PIE = 0x40;
const B_AIE = 0x20;
const B_UIE = 0x10;
const B_BINARY = 0x04;
const B_24H = 0x02;
const C_IRQF = 0x80;
const C_PF = 0x40;
const C_AF = 0x20;
const C_UF = 0x10;
const NS_PER_SECOND = 1e9;
/** The update-in-progress bit is set for this long before each second's update. */
const UIP_NS = 244_000;

/** The boot devices SeaBIOS can be told to try, in CMOS's numbering. */
export type BootDevice = 'floppy' | 'hd' | 'cdrom';
const BOOT_CODES: Record<BootDevice, number> = { floppy: 1, hd: 2, cdrom: 3 };

export interface CmosConfig {
  /** RAM in bytes. */
  memory: number;
  bootOrder: BootDevice[];
  /** Floppy drive A: 1.44 MB (type 4), or none. */
  floppy: boolean;
}

const toBcd = (v: number) => ((Math.floor(v / 10) << 4) | v % 10) & 0xff;
const fromBcd = (v: number) => (v >> 4) * 10 + (v & 0xf);

/**
 * The MC146818 real-time clock and its CMOS memory: the date and time
 * (starting from the host's clock at power on and kept by emulated time),
 * the periodic, alarm and update interrupts on IRQ 8, and the settings the
 * BIOS reads (memory size, floppy type, boot order).
 */
export class Rtc {
  readonly cmos = new Uint8Array(128);
  index = 0;
  /** The NMI mask (bit 7 of port 70h). */
  nmiMasked = false;
  /** Seconds since 1970 at emulated time `baseNs`. */
  private baseSeconds = 0;
  private baseNs = 0;
  /** The clock's whole second last copied into the time registers. */
  private shownSecond = -1;
  nextPeriodic = Infinity;
  onIrq: (level: boolean) => void = () => {};

  constructor(private readonly clock: Clock) {}

  /** Sets the time (seconds since 1970, local time as the PC keeps it) and the BIOS settings. */
  powerOn(config: CmosConfig, localSeconds: number): void {
    this.cmos.fill(0);
    this.baseSeconds = localSeconds;
    this.baseNs = this.clock.now();
    this.shownSecond = -1;
    const c = this.cmos;
    c[REG_A] = 0x26;
    c[REG_B] = B_24H;
    c[REG_D] = 0x80;
    c[0x10] = config.floppy ? 0x40 : 0;
    // Equipment: a floppy drive, the FPU, a VGA.
    c[0x14] = (config.floppy ? 0x01 : 0) | 0x02;
    c[0x15] = 640 & 0xff;
    c[0x16] = 640 >> 8;
    const extKb = Math.min((config.memory - 0x100000) / 1024, 0xfc00);
    c[0x17] = c[0x30] = extKb & 0xff;
    c[0x18] = c[0x31] = extKb >> 8;
    const above16 = Math.max(0, (config.memory - 0x1000000) / 0x10000);
    c[0x34] = above16 & 0xff;
    c[0x35] = above16 >> 8;
    c[0x32] = 0x20;
    // SeaBIOS's boot order: first device in 3Dh's low nibble, second in its high nibble, third in 38h's high nibble.
    const codes = config.bootOrder.map((device) => BOOT_CODES[device]);
    c[0x3d] = (codes[0] ?? 0) | ((codes[1] ?? 0) << 4);
    c[0x38] = (codes[2] ?? 0) << 4;
    let sum = 0;
    for (let i = 0x10; i <= 0x2d; i++) sum += c[i];
    c[0x2e] = sum >> 8;
    c[0x2f] = sum & 0xff;
    this.updateTime(true);
    this.schedulePeriodic();
  }

  private get seconds(): number {
    return this.baseSeconds + (this.clock.now() - this.baseNs) / NS_PER_SECOND;
  }

  private encode(v: number): number {
    return this.cmos[REG_B] & B_BINARY ? v : toBcd(v);
  }

  private decode(v: number): number {
    return this.cmos[REG_B] & B_BINARY ? v : fromBcd(v);
  }

  /** Copies the clock into the time registers when the second changes. */
  private updateTime(force = false): void {
    if (this.cmos[REG_B] & B_SET && !force) return;
    const whole = Math.floor(this.seconds);
    if (whole === this.shownSecond && !force) return;
    const updated = this.shownSecond >= 0 && whole !== this.shownSecond;
    this.shownSecond = whole;
    const d = new Date(whole * 1000);
    const c = this.cmos;
    c[0x00] = this.encode(d.getUTCSeconds());
    c[0x02] = this.encode(d.getUTCMinutes());
    let hours = d.getUTCHours();
    if (!(c[REG_B] & B_24H)) {
      const pm = hours >= 12;
      hours = hours % 12 || 12;
      c[0x04] = this.encode(hours) | (pm ? 0x80 : 0);
    } else {
      c[0x04] = this.encode(hours);
    }
    c[0x06] = this.encode(d.getUTCDay() + 1);
    c[0x07] = this.encode(d.getUTCDate());
    c[0x08] = this.encode(d.getUTCMonth() + 1);
    c[0x09] = this.encode(d.getUTCFullYear() % 100);
    c[0x32] = this.encode(Math.floor(d.getUTCFullYear() / 100));
    if (!updated) return;
    let flags = C_UF;
    if (c[0x01] === c[0x00] && c[0x03] === c[0x02] && c[0x05] === c[0x04]) flags |= C_AF;
    this.setFlags(flags);
  }

  /** Writes the time registers back into the clock (after the guest sets the time). */
  private readTimeRegisters(): void {
    const c = this.cmos;
    let hours = this.decode(c[0x04] & 0x7f);
    if (!(c[REG_B] & B_24H)) {
      hours %= 12;
      if (c[0x04] & 0x80) hours += 12;
    }
    const year = this.decode(c[0x32]) * 100 + this.decode(c[0x09]);
    const ms = Date.UTC(year, this.decode(c[0x08]) - 1, this.decode(c[0x07]), hours, this.decode(c[0x02]), this.decode(c[0x00]));
    if (Number.isFinite(ms)) {
      this.baseSeconds = ms / 1000;
      this.baseNs = this.clock.now();
      this.shownSecond = Math.floor(this.baseSeconds);
    }
  }

  private setFlags(flags: number): void {
    const c = this.cmos;
    c[REG_C] |= flags;
    const b = c[REG_B];
    const enabled = (b & B_PIE ? C_PF : 0) | (b & B_AIE ? C_AF : 0) | (b & B_UIE ? C_UF : 0);
    if (c[REG_C] & enabled && !(c[REG_C] & C_IRQF)) {
      c[REG_C] |= C_IRQF;
      this.onIrq(true);
    }
  }

  private get periodNs(): number {
    const rate = this.cmos[REG_A] & 0x0f;
    if (rate === 0) return 0;
    const r = rate < 3 ? rate + 7 : rate;
    return (NS_PER_SECOND * (1 << (r - 1))) / 32768;
  }

  private schedulePeriodic(): void {
    const period = this.periodNs;
    this.nextPeriodic = this.cmos[REG_B] & B_PIE && period ? this.clock.now() + period : Infinity;
  }

  /** The next time something happens: the periodic interrupt, or the next second when its interrupts are enabled. */
  get nextEvent(): number {
    let next = this.nextPeriodic;
    if (this.cmos[REG_B] & (B_UIE | B_AIE)) {
      const s = this.seconds;
      next = Math.min(next, this.clock.now() + (Math.floor(s) + 1 - s) * NS_PER_SECOND);
    }
    return next;
  }

  update(now: number): void {
    if (now >= this.nextPeriodic) {
      this.setFlags(C_PF);
      const period = this.periodNs;
      this.nextPeriodic += period;
      if (this.nextPeriodic < now) this.nextPeriodic = now + period;
    }
    if (this.cmos[REG_B] & (B_UIE | B_AIE)) this.updateTime();
  }

  write(port: number, value: number): void {
    if ((port & 1) === 0) {
      this.index = value & 0x7f;
      this.nmiMasked = (value & 0x80) !== 0;
      return;
    }
    const i = this.index;
    switch (i) {
      case REG_A:
        this.cmos[REG_A] = (this.cmos[REG_A] & 0x80) | (value & 0x7f);
        this.schedulePeriodic();
        return;
      case REG_B: {
        const wasSet = this.cmos[REG_B] & B_SET;
        this.cmos[REG_B] = value;
        if (value & B_SET) this.cmos[REG_B] &= ~B_UIE;
        if (wasSet && !(value & B_SET)) this.readTimeRegisters();
        this.schedulePeriodic();
        return;
      }
      case REG_C:
      case REG_D:
        return;
      default:
        this.cmos[i] = value;
        if (i <= 9 && i !== 1 && i !== 3 && i !== 5 && !(this.cmos[REG_B] & B_SET)) this.readTimeRegisters();
    }
  }

  read(port: number): number {
    if ((port & 1) === 0) return 0xff;
    const i = this.index;
    if (i <= 9 || i === 0x32) this.updateTime();
    switch (i) {
      case REG_A: {
        const intoSecond = (this.seconds % 1) * NS_PER_SECOND;
        const uip = !(this.cmos[REG_B] & B_SET) && intoSecond > NS_PER_SECOND - UIP_NS ? 0x80 : 0;
        return (this.cmos[REG_A] & 0x7f) | uip;
      }
      case REG_C: {
        const value = this.cmos[REG_C];
        this.cmos[REG_C] = 0;
        if (value & C_IRQF) this.onIrq(false);
        return value;
      }
      default:
        return this.cmos[i];
    }
  }
}
