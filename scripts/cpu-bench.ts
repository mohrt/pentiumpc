// Times the CPU alone on small loops, to see the interpreter's cost per instruction.
// npx rolldown scripts/cpu-bench.ts -o .profile/cpu-bench.mjs --platform node && node .profile/cpu-bench.mjs
import { Cpu, type CpuHost } from '../src/cpu/cpu';

class Host implements CpuHost {
  readonly ram = new Uint8Array(1 << 20);
  directPage(address: number): number {
    return address < this.ram.length ? address : -1;
  }
  readMemory8(): number {
    return 0xff;
  }
  writeMemory8(): void {}
  in8(): number {
    return 0xff;
  }
  in16(): number {
    return 0xffff;
  }
  in32(): number {
    return -1;
  }
  out8(): void {}
  out16(): void {}
  out32(): void {}
  acknowledgeInterrupt(): number {
    return -1;
  }
  shutdown(): void {}
  fpuError(): void {}
}

// Each loops for ever (the counts wrap), so every instruction run is one of the loop's.
const LOOPS: Record<string, number[]> = {
  // l: add ax, bx / dec cx / jnz l / jmp l
  'register loop (16-bit)': [0x01, 0xd8, 0x49, 0x75, 0xfb, 0xeb, 0xf9],
  // l: mov ax, [si] / add [di], ax / inc si / inc si / and si, 0FFh / jmp l
  'memory loop (16-bit)': [0x8b, 0x04, 0x01, 0x05, 0x46, 0x46, 0x81, 0xe6, 0xff, 0x00, 0xeb, 0xf4],
  // l: add eax, ebx / mov [esi], eax / dec ecx / jmp l   (66h and 67h prefixes in a 16-bit segment)
  'prefixed loop': [0x66, 0x01, 0xd8, 0x67, 0x66, 0x89, 0x06, 0x66, 0x49, 0xeb, 0xf5],
};

for (const [name, code] of Object.entries(LOOPS)) {
  const host = new Host();
  const cpu = new Cpu(host);
  cpu.setRealSegment(1, 0x1000);
  cpu.eip = 0;
  host.ram.set(code, 0x10000);
  cpu.regs[1] = 0x7fffffff;
  cpu.regs[6] = 0x2000;
  cpu.regs[7] = 0x3000;
  let exceptions = 0;
  cpu.onException = (vector) => {
    if (exceptions++ < 3) console.log(`  exception ${vector} at ${(cpu.eip >>> 0).toString(16)}`);
  };
  const n = 30_000_000;
  const start = performance.now();
  for (let i = 0; i < n; i += 100_000) cpu.run(100_000);
  const ms = performance.now() - start;
  console.log(`${name}: ${(n / ms / 1000).toFixed(1)} M instructions/s, ${exceptions} exceptions, ${cpu.halted ? 'halted' : 'running'}`);
}
