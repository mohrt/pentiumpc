/** A minimal async key-value store, so persistence can be swapped for an in-memory one in tests. */
export interface KeyValueStore<T> {
  get(key: string): Promise<T | undefined>;
  put(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  entries(): Promise<[string, T][]>;
}

export class MemoryStore<T> implements KeyValueStore<T> {
  private readonly data = new Map<string, T>();

  async get(key: string): Promise<T | undefined> {
    return this.data.get(key);
  }

  async put(key: string, value: T): Promise<void> {
    this.data.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.data.delete(key);
  }

  async entries(): Promise<[string, T][]> {
    return [...this.data.entries()];
  }
}

/** Save states and the changes games have written to their disks. */
const SAVES_DATABASE = { name: 'amiga-emulator', stores: ['diskSaves', 'saveDisks', 'saveStates'] } as const;
/** The user's ROMs, in their own database so the ROMs and the saves can change apart. */
const ROMS_DATABASE = { name: 'amiga-system-roms', stores: ['systemRoms'] } as const;
/** The hard disk, in its own database: it can run to hundreds of megabytes. */
const HARD_DISK_DATABASE = { name: 'amiga-hard-disk', stores: ['hardDisk'] } as const;
export type StoreName =
  | (typeof SAVES_DATABASE.stores)[number]
  | (typeof ROMS_DATABASE.stores)[number]
  | (typeof HARD_DISK_DATABASE.stores)[number];

/** How long opening storage may take before the page says it's waiting. */
const SLOW_OPEN_MS = 3000;

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

class IndexedDbStore<T> implements KeyValueStore<T> {
  constructor(
    private readonly db: IDBDatabase,
    private readonly name: StoreName,
  ) {}

  private store(mode: IDBTransactionMode): IDBObjectStore {
    return this.db.transaction(this.name, mode).objectStore(this.name);
  }

  async get(key: string): Promise<T | undefined> {
    return (await request(this.store('readonly').get(key))) as T | undefined;
  }

  async put(key: string, value: T): Promise<void> {
    await request(this.store('readwrite').put(value, key));
  }

  async delete(key: string): Promise<void> {
    await request(this.store('readwrite').delete(key));
  }

  async entries(): Promise<[string, T][]> {
    const store = this.store('readonly');
    const [keys, values] = await Promise.all([request(store.getAllKeys()), request(store.getAll())]);
    return keys.map((key, i) => [String(key), values[i] as T]);
  }
}

function openAt(name: string, storeNames: readonly string[], version?: number): Promise<IDBDatabase> {
  const open = version === undefined ? indexedDB.open(name) : indexedDB.open(name, version);
  open.onupgradeneeded = () => {
    for (const store of storeNames) {
      if (!open.result.objectStoreNames.contains(store)) open.result.createObjectStore(store);
    }
  };
  return request(open);
}

/**
 * Opens a database at whatever version it already has, so it never waits on an
 * upgrade that a tab running an older version of the page could block. Only
 * upgrades when a store is missing.
 */
async function openDatabase(name: string, storeNames: readonly string[]): Promise<IDBDatabase> {
  let db = await openAt(name, storeNames);
  if (!storeNames.every((store) => db.objectStoreNames.contains(store))) {
    const version = db.version + 1;
    db.close();
    db = await openAt(name, storeNames, version);
  }
  // Let a newer version of the page, opened in another tab, upgrade the database.
  db.onversionchange = () => db.close();
  return db;
}

/**
 * Opens the browser databases. Asks the browser to keep the data even under
 * storage pressure; users can still clear it with the site's data.
 * `onSlow` is called if opening takes unusually long (another tab holding up the browser's storage).
 */
export async function openBrowserStores(onSlow?: () => void): Promise<Record<StoreName, KeyValueStore<unknown>>> {
  void navigator.storage?.persist?.();
  const slowTimer = setTimeout(() => onSlow?.(), SLOW_OPEN_MS);
  try {
    const stores = {} as Record<StoreName, KeyValueStore<unknown>>;
    for (const { name, stores: storeNames } of [SAVES_DATABASE, ROMS_DATABASE, HARD_DISK_DATABASE]) {
      const db = await openDatabase(name, storeNames);
      for (const store of storeNames) stores[store] = new IndexedDbStore(db, store);
    }
    return stores;
  } finally {
    clearTimeout(slowTimer);
  }
}

/** In-memory stores, used when the browser has no IndexedDB (and in tests). */
export function memoryStores(): Record<StoreName, KeyValueStore<unknown>> {
  return {
    diskSaves: new MemoryStore(),
    saveDisks: new MemoryStore(),
    saveStates: new MemoryStore(),
    systemRoms: new MemoryStore(),
    hardDisk: new MemoryStore(),
  };
}
