// Downloads freely distributable disk images the boot tests use into disks/ (not committed):
// FreeDOS 1.2 installed on a 400 MB hard disk, from the in-browser-virtual-machine project.
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'disks');
const DISKS = [
  {
    file: 'freedos12.img',
    url: 'https://raw.githubusercontent.com/nadchif/in-browser-virtual-machine/ce299fbf6d130d8e4bee00895be22ffd3ccfc2a4/public/images/qemu-fd12-base.zip',
    sha256: '2900ee67ded38c58680c6b1ae667b2d01ea611c63c83f19bbef53e3da3735820',
    zipEntry: 'fd12-base.img',
  },
];

/** One file from a .zip (stored or deflated), found through the central directory. */
function unzipEntry(zip, wanted) {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  let offset = zip.readUInt32LE(end + 16);
  for (let i = 0; i < zip.readUInt16LE(end + 10); i++) {
    const method = zip.readUInt16LE(offset + 10);
    const size = zip.readUInt32LE(offset + 20);
    const nameLength = zip.readUInt16LE(offset + 28);
    const skip = nameLength + zip.readUInt16LE(offset + 30) + zip.readUInt16LE(offset + 32);
    const local = zip.readUInt32LE(offset + 42);
    const name = zip.toString('utf8', offset + 46, offset + 46 + nameLength);
    if (name === wanted) {
      const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
      const data = zip.subarray(start, start + size);
      return method === 0 ? Buffer.from(data) : inflateRawSync(data);
    }
    offset += 46 + skip;
  }
  throw new Error(`${wanted} is not in the zip`);
}

await mkdir(outDir, { recursive: true });
for (const disk of DISKS) {
  const target = join(outDir, disk.file);
  if (existsSync(target)) {
    console.log(`${disk.file} is already there`);
    continue;
  }
  const response = await fetch(disk.url);
  if (!response.ok) throw new Error(`${disk.file}: HTTP ${response.status}`);
  const download = Buffer.from(await response.arrayBuffer());
  const hash = createHash('sha256').update(download).digest('hex');
  if (disk.sha256 && hash !== disk.sha256) throw new Error(`${disk.file}: the download has changed (sha256 ${hash})`);
  await writeFile(target, disk.zipEntry ? unzipEntry(download, disk.zipEntry) : download);
  console.log(`Saved disks/${disk.file} (download sha256 ${hash})`);
}
