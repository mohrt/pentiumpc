// Downloads the PC's firmware into public/bios/: SeaBIOS 1.16.2 and its VGA BIOS, as the v86
// project builds them for an i440FX PC with a Bochs VGA card (LGPL 3; the sources are at
// https://www.seabios.org/ and the build configurations in v86's bios/ folder). The debug build
// writes its boot log to port 0x402, which the tests can show.
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const COMMIT = 'cc37f35c43bf14865d74ad76879ecf9410f69eb1';
const base = `https://raw.githubusercontent.com/copy/v86/${COMMIT}/bios`;
const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'bios');
const FILES = ['seabios.bin', 'vgabios.bin', 'seabios-debug.bin', 'vgabios-debug.bin', 'seabios.config', 'COPYING.LESSER'];

await mkdir(outDir, { recursive: true });
for (const name of FILES) {
  const response = await fetch(`${base}/${name}`);
  if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  await writeFile(join(outDir, name), bytes);
  console.log(`${name}: ${bytes.length} bytes, sha256 ${createHash('sha256').update(bytes).digest('hex')}`);
}
