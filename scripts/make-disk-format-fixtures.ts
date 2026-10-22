// Makes tests/fixtures/disk-formats: the pattern disk converted by qemu-img (in Docker)
// to each format the import reads, gzipped. Run from the project folder:
//   npx rolldown scripts/make-disk-format-fixtures.ts -o .profile/make-fixtures.mjs --platform node && node .profile/make-fixtures.mjs
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { patternDisk } from '../tests/helpers/pattern-disk';

const dir = resolve('tests/fixtures/disk-formats');
const work = resolve('.profile/disk-formats');
const join = (folder: string, file: string) => resolve(folder, file);
mkdirSync(dir, { recursive: true });
mkdirSync(work, { recursive: true });
writeFileSync(join(work, 'raw.img'), patternDisk());

const conversions: [file: string, args: string[]][] = [
  ['dynamic.vhd', ['-O', 'vpc', '-o', 'subformat=dynamic,force_size=on']],
  ['fixed.vhd', ['-O', 'vpc', '-o', 'subformat=fixed,force_size=on']],
  ['sparse.vmdk', ['-O', 'vmdk', '-o', 'subformat=monolithicSparse']],
  ['dynamic.vdi', ['-O', 'vdi']],
  ['static.vdi', ['-O', 'vdi', '-o', 'static=on']],
  ['v3.qcow2', ['-O', 'qcow2']],
  ['v2.qcow2', ['-O', 'qcow2', '-o', 'compat=0.10']],
  ['compressed.qcow2', ['-O', 'qcow2', '-c']],
  ['stream.vmdk', ['-O', 'vmdk', '-o', 'subformat=streamOptimized']],
];
const commands = conversions.map(([file, args]) => `qemu-img convert -f raw ${args.join(' ')} /work/raw.img /work/${file}`).join(' && ');
execFileSync('docker', ['run', '--rm', '-v', `${work}:/work`, 'debian:bookworm-slim', 'sh', '-c', `apt-get update -qq && apt-get install -y -qq qemu-utils >/dev/null && ${commands}`], { stdio: 'inherit' });
for (const [file] of conversions) writeFileSync(join(dir, `${file}.gz`), gzipSync(readFileSync(join(work, file)), { level: 9 }));
rmSync(work, { recursive: true });
