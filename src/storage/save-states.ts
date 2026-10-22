import type { StateNode } from '../state/snapshot';
import { decodeState, encodeState } from '../state/snapshot';
import type { DiskOrigin } from './disk-saves';
import type { KeyValueStore } from './store';

/** A disk in a drive when the state was saved: its contents then, and where its saves go. */
export interface SessionDisk {
  name: string;
  adf: Uint8Array;
  origin: DiskOrigin | null;
}

/** Everything needed to resume: the machine, its setup and the disks in its drives. */
export interface Session {
  machine: StateNode;
  /** CRC-32 of the Kickstart it ran (a state only makes sense with the same ROM). */
  kickstartCrc: number;
  kickstartTitle: string;
  standard: 'pal' | 'ntsc';
  memory: { chipKb: number; slowKb: number };
  externalDrive: boolean;
  disks: (SessionDisk | null)[];
}

export interface SaveStateRecord {
  name: string;
  created: number;
  /** The session, gzipped (the same format as exported .amigastate files). */
  bytes: Uint8Array;
}

export interface SaveStateInfo {
  id: string;
  name: string;
  created: number;
}

/** Older states are dropped beyond this many. */
const MAX_STATES = 30;

/** Save states kept in browser storage, newest first. */
export class SaveStates {
  constructor(private readonly store: KeyValueStore<SaveStateRecord>) {}

  async add(name: string, session: Session): Promise<void> {
    const created = Date.now();
    await this.store.put(`state-${created}`, { name, created, bytes: await encodeSession(session) });
    const all = await this.list();
    for (const old of all.slice(MAX_STATES)) await this.store.delete(old.id);
  }

  async list(): Promise<SaveStateInfo[]> {
    const entries = await this.store.entries();
    return entries.map(([id, record]) => ({ id, name: record.name, created: record.created })).sort((a, b) => b.created - a.created);
  }

  async load(id: string): Promise<Session | null> {
    const record = await this.store.get(id);
    return record ? decodeSession(record.bytes) : null;
  }

  async delete(id: string): Promise<void> {
    await this.store.delete(id);
  }
}

const MAGIC = 'amiga500-session';

export async function encodeSession(session: Session): Promise<Uint8Array> {
  return encodeState({ magic: MAGIC, ...session });
}

export async function decodeSession(bytes: Uint8Array): Promise<Session> {
  const decoded = await decodeState<Session & { magic?: string }>(bytes).catch(() => null);
  if (decoded?.magic !== MAGIC) throw new Error('That file is not an Amiga 500 save state.');
  return decoded;
}
