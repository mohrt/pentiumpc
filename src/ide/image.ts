export const SECTOR_BYTES = 512;
/** Images are kept (and saved) in pieces this big, so a change only rewrites the pieces it touched. */
export const CHUNK_BYTES = 1 << 20;
const SECTORS_PER_CHUNK = CHUNK_BYTES / SECTOR_BYTES;

export interface Geometry {
  cylinders: number;
  heads: number;
  sectors: number;
}

/** Drives report 16 heads of 63 sectors, the usual IDE geometry; the BIOS translates it for large disks. */
const HEADS = 16;
const SECTORS = 63;
/** The most cylinders IDENTIFY can report (8 GB at 16 heads of 63 sectors); beyond that only LBA reaches. */
const MAX_CYLINDERS = 16383;

export function geometryFor(bytes: number): Geometry {
  const cylinders = Math.max(1, Math.floor(bytes / (HEADS * SECTORS * SECTOR_BYTES)));
  return { cylinders: Math.min(cylinders, MAX_CYLINDERS), heads: HEADS, sectors: SECTORS };
}

/** A hard disk's contents: whole 512-byte sectors, with the 1 MB pieces changed since the last save noted. */
export class HardDiskImage {
  readonly dirty = new Set<number>();
  readonly geometry: Geometry;

  constructor(
    readonly bytes: Uint8Array,
    geometry?: Geometry,
  ) {
    this.geometry = geometry ?? geometryFor(bytes.length);
  }

  /** An empty disk of about `megabytes`, a whole number of cylinders. */
  static blank(megabytes: number): HardDiskImage {
    const geometry = geometryFor(megabytes * 1024 * 1024);
    return new HardDiskImage(new Uint8Array(geometry.cylinders * geometry.heads * geometry.sectors * SECTOR_BYTES), geometry);
  }

  /** A raw disk image file (.img, .ima, .vhd without its footer), rounded down to whole sectors. */
  static fromFile(bytes: Uint8Array): HardDiskImage {
    let whole = bytes.length - (bytes.length % SECTOR_BYTES);
    // A fixed VHD is a raw image with a 512-byte footer starting "conectix".
    const footer = whole - SECTOR_BYTES;
    if (footer > 0 && new TextDecoder().decode(bytes.subarray(footer, footer + 8)) === 'conectix') whole = footer;
    if (whole < 64 * SECTOR_BYTES) throw new Error('That file is too small to be a hard disk image.');
    return new HardDiskImage(whole === bytes.length ? bytes : bytes.slice(0, whole));
  }

  get sectorCount(): number {
    return this.bytes.length / SECTOR_BYTES;
  }

  read(lba: number, into: Uint8Array, offset = 0): void {
    const at = lba * SECTOR_BYTES;
    into.set(this.bytes.subarray(at, at + SECTOR_BYTES), offset);
  }

  write(lba: number, from: Uint8Array, offset = 0): void {
    this.bytes.set(from.subarray(offset, offset + SECTOR_BYTES), lba * SECTOR_BYTES);
    this.dirty.add(Math.floor(lba / SECTORS_PER_CHUNK));
  }
}
