/** One 8259A programmable interrupt controller. */
class Pic8259 {
  irr = 0;
  imr = 0;
  isr = 0;
  /** Input lines as last seen, for edge detection. */
  lines = 0;
  /** Edge/level control (the PIIX's ELCR): set bits are level triggered. */
  elcr = 0;
  vectorBase = 0;
  priorityAdd = 0;
  readIsr = false;
  poll = false;
  specialMask = false;
  autoEoi = false;
  rotateOnAutoEoi = false;
  specialFullyNested = false;
  initStep = 0;
  needsIcw4 = false;
  single = false;

  constructor(readonly elcrMask: number) {}

  reset(): void {
    this.lines = 0;
    this.irr &= this.elcr;
    this.imr = 0;
    this.isr = 0;
    this.priorityAdd = 0;
    this.vectorBase = 0;
    this.readIsr = false;
    this.poll = false;
    this.specialMask = false;
    this.initStep = 0;
    this.autoEoi = false;
    this.rotateOnAutoEoi = false;
    this.specialFullyNested = false;
    this.needsIcw4 = false;
    this.single = false;
  }

  setLine(irq: number, level: boolean): void {
    const mask = 1 << irq;
    if (this.elcr & mask) {
      if (level) this.irr |= mask;
      else this.irr &= ~mask;
    } else if (level) {
      if (!(this.lines & mask)) this.irr |= mask;
    }
    if (level) this.lines |= mask;
    else this.lines &= ~mask;
  }

  /** The highest priority set bit of `mask` (0 is highest after rotation), or 8 for none. */
  private priority(mask: number): number {
    if (mask === 0) return 8;
    let p = 0;
    while (!(mask & (1 << ((p + this.priorityAdd) & 7)))) p++;
    return p;
  }

  /** The interrupt to raise next, or -1. `slaveLine` is the cascade input (IRQ2 on the master). */
  pending(cascade: number): number {
    const mask = this.irr & ~this.imr;
    const priority = this.priority(mask);
    if (priority === 8) return -1;
    let inService = this.isr;
    if (this.specialMask) inService &= ~this.imr;
    if (this.specialFullyNested && cascade >= 0) inService &= ~(1 << cascade);
    const current = this.priority(inService);
    return priority < current ? (priority + this.priorityAdd) & 7 : -1;
  }

  /** Acknowledges `irq`: it moves from requested to in service. */
  acknowledge(irq: number): void {
    const mask = 1 << irq;
    if (this.autoEoi) {
      if (this.rotateOnAutoEoi) this.priorityAdd = (irq + 1) & 7;
    } else {
      this.isr |= mask;
    }
    if (!(this.elcr & mask)) this.irr &= ~mask;
  }

  write(port: number, value: number): void {
    if ((port & 1) === 0) {
      if (value & 0x10) {
        // ICW1: start initialisation.
        this.reset();
        this.initStep = 1;
        this.needsIcw4 = (value & 1) !== 0;
        this.single = (value & 2) !== 0;
      } else if (value & 0x08) {
        // OCW3.
        if (value & 0x04) this.poll = true;
        if (value & 0x02) this.readIsr = (value & 1) !== 0;
        if (value & 0x40) this.specialMask = (value & 0x20) !== 0;
      } else {
        // OCW2.
        const command = value >> 5;
        switch (command) {
          case 0:
          case 4:
            this.rotateOnAutoEoi = command === 4;
            break;
          case 1:
          case 5: {
            const priority = this.priority(this.isr);
            if (priority !== 8) {
              const irq = (priority + this.priorityAdd) & 7;
              this.isr &= ~(1 << irq);
              if (command === 5) this.priorityAdd = (irq + 1) & 7;
            }
            break;
          }
          case 3:
            this.isr &= ~(1 << (value & 7));
            break;
          case 6:
            this.priorityAdd = (value + 1) & 7;
            break;
          case 7:
            this.isr &= ~(1 << (value & 7));
            this.priorityAdd = (value + 1) & 7;
            break;
        }
      }
      return;
    }
    switch (this.initStep) {
      case 0:
        this.imr = value;
        break;
      case 1:
        this.vectorBase = value & 0xf8;
        this.initStep = this.single ? (this.needsIcw4 ? 3 : 0) : 2;
        break;
      case 2:
        this.initStep = this.needsIcw4 ? 3 : 0;
        break;
      default:
        this.specialFullyNested = (value & 0x10) !== 0;
        this.autoEoi = (value & 0x02) !== 0;
        this.initStep = 0;
    }
  }

  read(port: number): number {
    if (this.poll) {
      this.poll = false;
      const irq = this.pending(-1);
      if (irq < 0) return 0;
      this.acknowledge(irq);
      return 0x80 | irq;
    }
    if (port & 1) return this.imr;
    return this.readIsr ? this.isr : this.irr;
  }
}

/**
 * The PC's two cascaded 8259s (the slave on the master's IRQ 2), with the PIIX's
 * edge/level control registers. The CPU's interrupt line follows `output`.
 */
export class Pics {
  readonly master = new Pic8259(0xf8);
  readonly slave = new Pic8259(0xde);
  /** Called whenever the interrupt output to the CPU may have changed. */
  onChange: (level: boolean) => void = () => {};

  reset(): void {
    this.master.reset();
    this.slave.reset();
    this.master.elcr = this.slave.elcr = 0;
    this.master.irr = this.slave.irr = 0;
    this.update();
  }

  setIrq(irq: number, level: boolean): void {
    if (irq < 8) this.master.setLine(irq, level);
    else this.slave.setLine(irq - 8, level);
    this.update();
  }

  /** A short pulse on an edge-triggered line. */
  pulseIrq(irq: number): void {
    this.setIrq(irq, true);
    this.setIrq(irq, false);
  }

  private update(): void {
    this.master.setLine(2, this.slave.pending(-1) >= 0);
    this.onChange(this.master.pending(2) >= 0);
  }

  /** INTA: the vector for the highest priority request (a spurious IRQ 7 or 15 if it went away). */
  acknowledge(): number {
    const irq = this.master.pending(2);
    if (irq < 0) {
      this.update();
      return this.master.vectorBase | 7;
    }
    this.master.acknowledge(irq);
    let vector: number;
    if (irq === 2) {
      const slaveIrq = this.slave.pending(-1);
      if (slaveIrq < 0) {
        vector = this.slave.vectorBase | 7;
      } else {
        this.slave.acknowledge(slaveIrq);
        vector = this.slave.vectorBase | slaveIrq;
      }
    } else {
      vector = this.master.vectorBase | irq;
    }
    this.update();
    return vector;
  }

  write(port: number, value: number): void {
    if (port === 0x4d0) this.master.elcr = value & this.master.elcrMask;
    else if (port === 0x4d1) this.slave.elcr = value & this.slave.elcrMask;
    else if (port < 0xa0) this.master.write(port, value);
    else this.slave.write(port, value);
    this.update();
  }

  read(port: number): number {
    if (port === 0x4d0) return this.master.elcr;
    if (port === 0x4d1) return this.slave.elcr;
    const value = port < 0xa0 ? this.master.read(port) : this.slave.read(port);
    this.update();
    return value;
  }
}
