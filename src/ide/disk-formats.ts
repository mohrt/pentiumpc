import { HardDiskImage, SECTOR_BYTES } from './image';

/**
 * Hard disk image files from other emulators and virtual machines, unpacked
 * into a raw disk: Virtual PC and Hyper-V's VHD (fixed and dynamic), VMware's
 * VMDK (monolithic sparse), VirtualBox's VDI (dynamic and fixed) and QEMU's
 * qcow2 (without compression). Anything else is taken as a raw image.
 */

const CONVERT_HINT = 'Convert it to a raw image first, e.g. with qemu-img convert -O raw <file> disk.img';

class DiskFormatError extends Error {}

const fail = (message: string): never => {
  throw new DiskFormatError(`${message} ${CONVERT_HINT}`);
};

const ascii = (bytes: Uint8Array, start: number, length: number) => String.fromCharCode(...bytes.subarray(start, start + length));

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** A 64-bit field as a number (disk offsets and sizes stay far below 2^53). */
function u64(data: DataView, offset: number, little: boolean): number {
  return Number(data.getBigUint64(offset, little));
}

/** The disk's bytes, checking the size is one a browser can hold. */
function blankDisk(bytes: number): Uint8Array {
  if (!Number.isFinite(bytes) || bytes < 64 * SECTOR_BYTES) fail('That disk image says its disk is too small to use.');
  if (bytes > 8 * 1024 ** 3) fail(`That disk is ${Math.round(bytes / 1024 ** 3)} GB; disks of up to 8 GB fit in the browser.`);
  return new Uint8Array(Math.floor(bytes / SECTOR_BYTES) * SECTOR_BYTES);
}

/** Copies `length` bytes of the image file at `from` into the disk at `to`, checking they're inside the file. */
function copy(file: Uint8Array, from: number, disk: Uint8Array, to: number, length: number): void {
  const count = Math.min(length, disk.length - to);
  if (count <= 0) return;
  if (from + count > file.length) fail('That disk image is cut short (part of it is missing).');
  disk.set(file.subarray(from, from + count), to);
}

// --- VHD -------------------------------------------------------------------------------

const VHD_FIXED = 2;
const VHD_DYNAMIC = 3;
const VHD_DIFFERENCING = 4;

function vhdFooter(file: Uint8Array): number {
  // The footer is the last 512 bytes (511 in images from early Virtual PC versions).
  for (const size of [512, 511]) {
    const at = file.length - size;
    if (at >= 0 && ascii(file, at, 8) === 'conectix') return at;
  }
  return -1;
}

function readVhd(file: Uint8Array, footerAt: number): Uint8Array {
  const footer = view(file.subarray(footerAt, footerAt + 512));
  const type = footer.getUint32(60);
  const size = u64(footer, 48, false);
  if (type === VHD_FIXED) return file.slice(0, Math.min(footerAt, Math.floor(size / SECTOR_BYTES) * SECTOR_BYTES));
  if (type === VHD_DIFFERENCING) fail('That VHD is a differencing disk, which holds only the changes to another (parent) disk.');
  if (type !== VHD_DYNAMIC) fail('That VHD is of a kind this PC does not know.');
  const headerAt = u64(footer, 16, false);
  if (headerAt + 1024 > file.length || ascii(file, headerAt, 8) !== 'cxsparse') fail('That dynamic VHD is damaged (its header is missing).');
  const header = view(file.subarray(headerAt, headerAt + 1024));
  const tableAt = u64(header, 16, false);
  const entries = header.getUint32(28);
  const blockBytes = header.getUint32(32);
  if (!blockBytes || blockBytes % SECTOR_BYTES) fail('That dynamic VHD is damaged (bad block size).');
  const disk = blankDisk(size);
  const sectorsPerBlock = blockBytes / SECTOR_BYTES;
  const bitmapBytes = Math.ceil(sectorsPerBlock / 8 / SECTOR_BYTES) * SECTOR_BYTES;
  if (tableAt + entries * 4 > file.length) fail('That dynamic VHD is cut short (its block table is missing).');
  const table = view(file.subarray(tableAt, tableAt + entries * 4));
  for (let block = 0; block < entries; block++) {
    const sector = table.getUint32(block * 4);
    if (sector === 0xffffffff) continue;
    const bitmapAt = sector * SECTOR_BYTES;
    const dataAt = bitmapAt + bitmapBytes;
    const diskAt = block * blockBytes;
    if (bitmapAt + bitmapBytes > file.length) fail('That dynamic VHD is cut short (part of it is missing).');
    // The block's bitmap says which of its sectors hold data (most significant bit first); the rest read as zeros.
    const bitmap = file.subarray(bitmapAt, bitmapAt + Math.ceil(sectorsPerBlock / 8));
    if (bitmap.every((byte) => byte === 0xff)) {
      copy(file, dataAt, disk, diskAt, blockBytes);
      continue;
    }
    for (let s = 0; s < sectorsPerBlock; s++) {
      if (bitmap[s >> 3] & (0x80 >> (s & 7))) copy(file, dataAt + s * SECTOR_BYTES, disk, diskAt + s * SECTOR_BYTES, SECTOR_BYTES);
    }
  }
  return disk;
}

// --- VMDK ------------------------------------------------------------------------------

function readVmdk(file: Uint8Array): Uint8Array {
  const header = view(file.subarray(0, 512));
  const flags = header.getUint32(8, true);
  const capacity = u64(header, 12, true);
  const grainSectors = u64(header, 20, true);
  const tableEntries = header.getUint32(44, true);
  const directoryAt = header.getBigUint64(56, true);
  const compression = header.getUint16(77, true);
  if (compression !== 0 || directoryAt === 0xffffffffffffffffn || flags & 0x10000) fail('That VMDK is compressed (stream-optimized, as in .ova exports).');
  // The first file of a disk split into 2 GB pieces says so in its embedded description.
  const descriptorAt = u64(header, 28, true) * SECTOR_BYTES;
  const descriptor = descriptorAt ? ascii(file, descriptorAt, Math.min(u64(header, 36, true) * SECTOR_BYTES, 4096)) : '';
  if (/createType\s*=\s*"twoGbMaxExtent/.test(descriptor)) fail('That VMDK is one piece of a disk split into several files.');
  // Bit 1 of the flags says a redundant directory is in use; either copy works, so the primary is read.
  const disk = blankDisk(capacity * SECTOR_BYTES);
  const grainBytes = grainSectors * SECTOR_BYTES;
  if (!grainBytes || !tableEntries) fail('That VMDK is damaged (bad grain size).');
  const grains = Math.ceil(capacity / grainSectors);
  const tables = Math.ceil(grains / tableEntries);
  const directoryBytes = Number(directoryAt) * SECTOR_BYTES;
  if (directoryBytes + tables * 4 > file.length) fail('That VMDK is cut short (its grain directory is missing).');
  const directory = view(file.subarray(directoryBytes, directoryBytes + tables * 4));
  for (let t = 0; t < tables; t++) {
    const tableAt = directory.getUint32(t * 4, true) * SECTOR_BYTES;
    if (!tableAt) continue;
    if (tableAt + tableEntries * 4 > file.length) fail('That VMDK is cut short (a grain table is missing).');
    const table = view(file.subarray(tableAt, tableAt + tableEntries * 4));
    for (let g = 0; g < tableEntries; g++) {
      const grain = t * tableEntries + g;
      if (grain >= grains) break;
      // 0 is a grain never written, 1 one written as zeros.
      const sector = table.getUint32(g * 4, true);
      if (sector > 1) copy(file, sector * SECTOR_BYTES, disk, grain * grainBytes, grainBytes);
    }
  }
  return disk;
}

// --- VDI -------------------------------------------------------------------------------

const VDI_SIGNATURE = 0xbeda107f;
const VDI_FREE = 0xffffffff;
const VDI_ZERO = 0xfffffffe;

function readVdi(file: Uint8Array): Uint8Array {
  const header = view(file.subarray(0, 0x190));
  const type = header.getUint32(0x4c, true);
  if (type === 4) fail('That VDI is a differencing image, which holds only the changes to another disk.');
  const blocksAt = header.getUint32(0x154, true);
  const dataAt = header.getUint32(0x158, true);
  const size = u64(header, 0x170, true);
  const blockBytes = header.getUint32(0x178, true);
  const extraBytes = header.getUint32(0x17c, true);
  const blocks = header.getUint32(0x180, true);
  if (!blockBytes) fail('That VDI is damaged (bad block size).');
  const disk = blankDisk(size);
  if (blocksAt + blocks * 4 > file.length) fail('That VDI is cut short (its block map is missing).');
  const map = view(file.subarray(blocksAt, blocksAt + blocks * 4));
  for (let block = 0; block < blocks; block++) {
    const index = map.getUint32(block * 4, true);
    if (index === VDI_FREE || index === VDI_ZERO) continue;
    copy(file, dataAt + index * (blockBytes + extraBytes) + extraBytes, disk, block * blockBytes, blockBytes);
  }
  return disk;
}

// --- qcow2 -----------------------------------------------------------------------------

const QCOW_OFFSET_MASK = 0x00fffffffffffe00n;
const QCOW_COMPRESSED = 1n << 62n;
const QCOW_ZERO = 1n;

function readQcow2(file: Uint8Array): Uint8Array {
  const header = view(file.subarray(0, 104));
  const version = header.getUint32(4);
  if (version < 2) fail('That is a qcow image of the first version, which this PC can\'t read.');
  if (u64(header, 8, false) !== 0) fail('That qcow2 image is based on another image (a backing file).');
  if (header.getUint32(32) !== 0) fail('That qcow2 image is encrypted.');
  // Version 3's incompatible features: dirty (bit 0), corrupt (1) and the compression type (3) don't change the layout read here.
  if (version >= 3 && header.getBigUint64(72) & ~0b1011n) fail('That qcow2 image uses features this PC can\'t read (an external data file or subclusters).');
  const clusterBits = header.getUint32(20);
  if (clusterBits < 9 || clusterBits > 21) fail('That qcow2 image is damaged (bad cluster size).');
  const clusterBytes = 2 ** clusterBits;
  const disk = blankDisk(u64(header, 24, false));
  const l1Entries = header.getUint32(36);
  const l1At = u64(header, 40, false);
  const l2Entries = clusterBytes / 8;
  if (l1At + l1Entries * 8 > file.length) fail('That qcow2 image is cut short (its cluster table is missing).');
  const l1 = view(file.subarray(l1At, l1At + l1Entries * 8));
  for (let i = 0; i < l1Entries; i++) {
    const l2At = Number(l1.getBigUint64(i * 8) & QCOW_OFFSET_MASK);
    if (!l2At) continue;
    if (l2At + clusterBytes > file.length) fail('That qcow2 image is cut short (a cluster table is missing).');
    const l2 = view(file.subarray(l2At, l2At + clusterBytes));
    for (let j = 0; j < l2Entries; j++) {
      const diskAt = (i * l2Entries + j) * clusterBytes;
      if (diskAt >= disk.length) break;
      const entry = l2.getBigUint64(j * 8);
      if (entry & QCOW_COMPRESSED) fail('That qcow2 image is compressed.');
      const hostAt = Number(entry & QCOW_OFFSET_MASK);
      if (!hostAt || (version >= 3 && entry & QCOW_ZERO)) continue;
      copy(file, hostAt, disk, diskAt, clusterBytes);
    }
  }
  return disk;
}

// --- Detection -------------------------------------------------------------------------

/**
 * A hard disk from an image file's bytes: VHD, VMDK, VDI and qcow2 images are
 * unpacked; anything else is a raw disk. Throws, with a message for the user,
 * for images it can't use.
 */
export function openDiskImage(file: Uint8Array): HardDiskImage {
  const text = ascii(file, 0, 64);
  if (ascii(file, 0, 4) === 'KDMV') return new HardDiskImage(readVmdk(file));
  if (text.startsWith('# Disk DescriptorFile')) {
    fail('That .vmdk is only a description of the disk; its contents are in other files (usually named ...-flat.vmdk or ...-s001.vmdk). A -flat.vmdk file works as it is.');
  }
  if (file.length > 0x190 && view(file).getUint32(0x40, true) === VDI_SIGNATURE) return new HardDiskImage(readVdi(file));
  if (ascii(file, 0, 4) === 'QFI\xfb') return new HardDiskImage(readQcow2(file));
  const footer = vhdFooter(file);
  if (footer >= 0) return new HardDiskImage(readVhd(file, footer));
  return HardDiskImage.fromFile(file);
}

/** File names imported as hard disks whatever their size (raw .img files are told apart from floppies by size). */
export const HARD_DISK_EXTENSIONS = ['.vhd', '.vmdk', '.vdi', '.qcow2', '.qcow', '.hdd', '.raw'];
