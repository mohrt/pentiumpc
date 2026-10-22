// Downloads freely distributable operating systems the boot tests use into disks/ (not committed).
// A download that fails or no longer matches its checksum is skipped with a warning.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'disks');
const DISKS = [
  {
    // FreeDOS 1.2 installed on a 400 MB hard disk (GPL and other free licences), from the in-browser-virtual-machine project.
    file: 'freedos12.img',
    url: 'https://raw.githubusercontent.com/nadchif/in-browser-virtual-machine/ce299fbf6d130d8e4bee00895be22ffd3ccfc2a4/public/images/qemu-fd12-base.zip',
    sha256: '2900ee67ded38c58680c6b1ae667b2d01ea611c63c83f19bbef53e3da3735820',
    zipEntry: 'fd12-base.img',
  },
  {
    // ReactOS 0.4.15, the open-source Windows NT workalike (GPL): a bootable installation CD.
    file: 'reactos.iso',
    url: 'https://github.com/reactos/reactos/releases/download/0.4.15-release/ReactOS-0.4.15-release-1-gdbb43bbaeb2-x86-iso.zip',
    sha256: '2be97d87fd43c93185aa841c1742fe9265c58aba0e517e20122df19d9add1935',
    zipEntry: 'ReactOS-0.4.15-release-1-gdbb43bbaeb2-x86.iso',
  },
  {
    // Tiny Core Linux 15.0 (GPL): a bootable 18 MB CD with a Linux 6.6 kernel.
    file: 'tinycore.iso',
    url: 'http://tinycorelinux.net/15.x/x86/release/Core-15.0.iso',
    sha256: 'e2d98595cf62133df71516602c12aa685c6b4da19db3068d150e4946415d0d86',
  },
  {
    // KolibriOS (GPL), an operating system in assembly language on a 1.44 MB boot floppy. This is its
    // nightly build, so the checksum will stop matching when a new one comes out.
    file: 'kolibri.img',
    url: 'https://builds.kolibrios.org/en_US/latest-img.7z',
    sha256: 'd90f8fdb574f3ab6be98f899f96244433bf0e1ff071c58736d4e55fa1aa73f54',
    sevenZipEntry: 'kolibri.img',
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

/** One file from a .7z, with bsdtar (macOS's tar, and libarchive-tools on Linux). */
async function un7zEntry(archive, wanted) {
  const dir = await mkdtemp(join(tmpdir(), 'disks-'));
  try {
    const path = join(dir, 'archive.7z');
    await writeFile(path, archive);
    execFileSync(process.platform === 'darwin' ? 'tar' : 'bsdtar', ['-xf', path, '-C', dir, wanted]);
    return await readFile(join(dir, wanted));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

await mkdir(outDir, { recursive: true });
for (const disk of DISKS) {
  const target = join(outDir, disk.file);
  if (existsSync(target)) {
    console.log(`${disk.file} is already there`);
    continue;
  }
  try {
    const response = await fetch(disk.url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const download = Buffer.from(await response.arrayBuffer());
    const hash = createHash('sha256').update(download).digest('hex');
    if (hash !== disk.sha256) throw new Error(`the download has changed (sha256 ${hash})`);
    let bytes = download;
    if (disk.zipEntry) bytes = unzipEntry(download, disk.zipEntry);
    if (disk.sevenZipEntry) bytes = await un7zEntry(download, disk.sevenZipEntry);
    await writeFile(target, bytes);
    console.log(`Saved disks/${disk.file}`);
  } catch (error) {
    console.warn(`Skipping ${disk.file}: ${error.message}`);
  }
}
