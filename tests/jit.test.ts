import { describe, expect, it } from 'vitest';
import { Cpu, type CpuHost } from '../src/cpu/cpu';
import { CS, DS, SS } from '../src/cpu/constants';

/** A CPU on 1 MB of RAM, with an interrupt line raised by `irq` and acknowledged as vector 8. */
function machine() {
  const ram = new Uint8Array(1 << 20);
  let cpu: Cpu;
  const host: CpuHost = {
    ram,
    directPage: (address) => (address < ram.length ? address : -1),
    readMemory8: () => 0xff,
    writeMemory8: () => {},
    in8: () => 0xff,
    in16: () => 0xffff,
    in32: () => -1,
    out8: () => {},
    out16: () => {},
    out32: () => {},
    acknowledgeInterrupt: () => {
      cpu.irqLine = false;
      return 8;
    },
    shutdown: () => {},
    fpuError: () => {},
  };
  cpu = new Cpu(host);
  return { cpu, ram };
}

describe('translated blocks', () => {
  it('take a pending interrupt right after the instruction following STI, before a CLI', () => {
    const { cpu, ram } = machine();
    // loop: sti; nop; cli; cmp byte [2000h], 0; je loop; hlt
    ram.set([0xfb, 0x90, 0xfa, 0x80, 0x3e, 0x00, 0x20, 0x00, 0x74, 0xf6, 0xf4], 0x1000);
    // The interrupt handler (vector 8, at 0000:3000): mov byte [2000h], 1; iret
    ram.set([0xc6, 0x06, 0x00, 0x20, 0x01, 0xcf], 0x3000);
    ram.set([0x00, 0x30, 0x00, 0x00], 8 * 4);
    cpu.setRealSegment(CS, 0x100);
    cpu.setRealSegment(DS, 0);
    cpu.setRealSegment(SS, 0x800);
    cpu.eip = 0;
    cpu.regs[4] = 0x1000;
    cpu.jitThreshold = 1;
    // The loop runs a few times (translated by then) before the interrupt arrives.
    cpu.run(30);
    cpu.irqLine = true;
    cpu.run(200);
    expect(ram[0x2000]).toBe(1);
    expect(cpu.halted).toBe(true);
  });
});
