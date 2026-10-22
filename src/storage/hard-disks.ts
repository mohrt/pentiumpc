import { CHUNK_BYTES, HardDiskImage, type Geometry } from '../ide/image';
import type { KeyValueStore } from './store';

/** What the store holds under 'meta'; each 1 MB piece is under 'chunk-<n>', and pieces never written are left out. */
interface HardDiskMeta {
  name: string;
  bytes: number;
  geometry: Geometry;
  created: number;
}

export interface HardDiskInfo {
  name: string;
  bytes: number;
}

const META = 'meta';
const chunkKey = (index: number) => `chunk-${index}`;

/** Sizes offered for new hard disks, in megabytes. */
export const HARD_DISK_SIZES = [20, 40, 100, 250];

/**
 * The hard disk, kept in browser storage in 1 MB pieces: only the pieces a
 * program changed are written back, and pieces that are all zeros (most of a
 * new disk) aren't stored at all.
 */
export class HardDisks {
  constructor(private readonly store: KeyValueStore<unknown>) {}

  async info(): Promise<HardDiskInfo | null> {
    const meta = (await this.store.get(META)) as HardDiskMeta | undefined;
    return meta ? { name: meta.name, bytes: meta.bytes } : null;
  }

  async load(): Promise<HardDiskImage | null> {
    const meta = (await this.store.get(META)) as HardDiskMeta | undefined;
    if (!meta) return null;
    const bytes = new Uint8Array(meta.bytes);
    for (const [key, value] of await this.store.entries()) {
      if (!key.startsWith('chunk-')) continue;
      const offset = Number(key.slice(6)) * CHUNK_BYTES;
      if (offset < bytes.length) bytes.set((value as Uint8Array).subarray(0, bytes.length - offset), offset);
    }
    return new HardDiskImage(bytes, meta.geometry);
  }

  /** Replaces the stored disk with this one, writing all its non-empty pieces. */
  async replace(image: HardDiskImage, name: string): Promise<void> {
    await this.delete();
    void globalThis.navigator?.storage?.persist?.().catch(() => false);
    const meta: HardDiskMeta = { name, bytes: image.bytes.length, geometry: image.geometry, created: Date.now() };
    for (let index = 0; index * CHUNK_BYTES < image.bytes.length; index++) {
      const piece = image.bytes.subarray(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES);
      if (piece.some((byte) => byte !== 0)) await this.store.put(chunkKey(index), piece.slice());
    }
    await this.store.put(META, meta);
    image.dirty.clear();
  }

  /** Writes back the pieces a program changed since the last save. */
  async persist(image: HardDiskImage): Promise<void> {
    if (image.dirty.size === 0) return;
    const changed = [...image.dirty];
    image.dirty.clear();
    for (const index of changed) {
      await this.store.put(chunkKey(index), image.bytes.slice(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES));
    }
  }

  async delete(): Promise<void> {
    const meta = (await this.store.get(META)) as HardDiskMeta | undefined;
    if (!meta) return;
    for (let index = 0; index * CHUNK_BYTES < meta.bytes; index++) await this.store.delete(chunkKey(index));
    await this.store.delete(META);
  }
}
