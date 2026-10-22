import { CHUNK_BYTES, HardDiskImage, type Geometry } from '../ide/image';
import type { KeyValueStore } from './store';

/** What the store holds under '<id>/meta'; each 1 MB piece is under '<id>/chunk-<n>', and pieces never written are left out. */
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

/** Sizes offered for new hard disks, in megabytes. */
export const HARD_DISK_SIZES = [100, 250, 500, 1000, 2000];

/**
 * The hard disks kept in browser storage, one for each machine preset, in 1 MB
 * pieces: only the pieces a program changed are written back, and pieces that
 * are all zeros (most of a new disk) aren't stored at all.
 */
export class HardDisks {
  constructor(private readonly store: KeyValueStore<unknown>) {}

  private metaKey(id: string): string {
    return `${id}/meta`;
  }

  private chunkKey(id: string, index: number): string {
    return `${id}/chunk-${index}`;
  }

  async info(id: string): Promise<HardDiskInfo | null> {
    const meta = (await this.store.get(this.metaKey(id))) as HardDiskMeta | undefined;
    return meta ? { name: meta.name, bytes: meta.bytes } : null;
  }

  /** Loads a disk; `onProgress` gets the share done (0 to 1). */
  async load(id: string, onProgress?: (done: number) => void): Promise<HardDiskImage | null> {
    const meta = (await this.store.get(this.metaKey(id))) as HardDiskMeta | undefined;
    if (!meta) return null;
    const bytes = new Uint8Array(meta.bytes);
    const prefix = `${id}/chunk-`;
    const keys = (await this.store.keys()).filter((key) => key.startsWith(prefix));
    for (let i = 0; i < keys.length; i++) {
      const offset = Number(keys[i].slice(prefix.length)) * CHUNK_BYTES;
      const piece = (await this.store.get(keys[i])) as Uint8Array | undefined;
      if (piece && offset < bytes.length) bytes.set(piece.subarray(0, bytes.length - offset), offset);
      onProgress?.((i + 1) / keys.length);
    }
    return new HardDiskImage(bytes, meta.geometry);
  }

  /** Replaces the stored disk with this one, writing all its non-empty pieces. */
  async replace(id: string, image: HardDiskImage, name: string, onProgress?: (done: number) => void): Promise<void> {
    await this.delete(id);
    void globalThis.navigator?.storage?.persist?.().catch(() => false);
    const meta: HardDiskMeta = { name, bytes: image.bytes.length, geometry: image.geometry, created: Date.now() };
    const chunks = Math.ceil(image.bytes.length / CHUNK_BYTES);
    for (let index = 0; index < chunks; index++) {
      const piece = image.bytes.subarray(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES);
      if (piece.some((byte) => byte !== 0)) await this.store.put(this.chunkKey(id, index), piece.slice());
      onProgress?.((index + 1) / chunks);
    }
    await this.store.put(this.metaKey(id), meta);
    image.dirty.clear();
  }

  /** Writes back the pieces a program changed since the last save. */
  async persist(id: string, image: HardDiskImage): Promise<void> {
    if (image.dirty.size === 0) return;
    const changed = [...image.dirty];
    image.dirty.clear();
    for (const index of changed) {
      await this.store.put(this.chunkKey(id, index), image.bytes.slice(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES));
    }
  }

  async delete(id: string): Promise<void> {
    const prefix = `${id}/`;
    for (const key of await this.store.keys()) if (key.startsWith(prefix)) await this.store.delete(key);
  }
}
