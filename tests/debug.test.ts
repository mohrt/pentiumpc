import { readFileSync } from 'node:fs';
import { it } from 'vitest';
import { CS, DS, EAX, EBX, ECX, EDI, EDX, ES, ESI, ESP, EBP, SS } from '../src/cpu/constants';
import { HardDiskImage } from '../src/ide/image';
import { bootedPc } from './helpers/machine';

it.skipIf(!process.env.DEBUG_BOOT)('debug boot', { timeout: 600_000 }, () => {
  const disk = HardDiskImage.fromFile(new Uint8Array(readFileSync('disks/freedos12.img')));
  const pc = bootedPc({ debug: false, config: { bootOrder: ['hd', 'cdrom', 'floppy'] }, setup: (p) => p.attachHardDisk(disk) });
  const cpu = pc.cpu;
  const hex = (n: number) => (n >>> 0).toString(16);
  let count = 0;
  cpu.onException = (vector, code) => {
    if (count++ > 6) return;
    const lin = cpu.linearIp;
    const bytes = Array.from({ length: 8 }, (_, k) => pc.ram[lin + k].toString(16).padStart(2, '0')).join(' ');
    const r = cpu.regs;
    console.log(`exception ${vector} code ${code} at ${hex(cpu.sel[CS])}:${hex(cpu.eip)} [${bytes}] eax=${hex(r[EAX])} ebx=${hex(r[EBX])} ecx=${hex(r[ECX])} edx=${hex(r[EDX])} esi=${hex(r[ESI])} edi=${hex(r[EDI])} ebp=${hex(r[EBP])} esp=${hex(r[ESP])} ds=${hex(cpu.sel[DS])} es=${hex(cpu.sel[ES])} ss=${hex(cpu.sel[SS])} cr0=${hex(cpu.cr0)}`);
  };
  for (let i = 0; i < 300 && count < 6; i++) pc.runFor(10_000_000);
  console.log(pc.vga.screenText());
});
