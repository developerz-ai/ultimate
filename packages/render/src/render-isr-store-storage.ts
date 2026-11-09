/**
 * The shared ISR store: pages and tag-fence generations as objects on a disk every replica
 * reads, so three web replicas hold ONE copy of a page and a purge on any of them takes it down
 * everywhere. Over `@ultimat3/storage`'s `StorageDriver` — `disk('isr')` — by its shape.
 */

import type { Page } from '@ultimat3/core';
import { finiteCount, isUltimateError, logger } from '@ultimat3/core';
import type { IsrEntry, IsrStore, IsrTagFence } from './render-isr-store';
import { DEFAULT_ISR_MAX_BYTES, DEFAULT_ISR_MAX_ENTRIES } from './render-isr-store';
import { parseIsrEntry } from './render-isr-store-codec';

/** One object of a listing: what eviction needs. `StorageListEntry` is one. */
export interface IsrDiskEntry {
  readonly key: string;
  readonly size: number;
  readonly lastModified?: Date | undefined;
}

/**
 * The calls this store makes. `@ultimat3/storage`'s `StorageDriver` satisfies it as it is, so
 * `storageIsrStore({ disk: disk('isr') })` needs no adapter; any other disk implementing these
 * five does too. Render takes no import of storage for it: the store needs a shape, not a package.
 */
export interface IsrDisk {
  put(
    key: string,
    body: Uint8Array,
    options?: { readonly contentType?: string | undefined },
  ): Promise<unknown>;
  /** Raises a coded `X_STORAGE_NOT_FOUND` for an absent key, as every shipped driver does. */
  get(key: string): Promise<{ readonly bytes: Uint8Array }>;
  delete(key: string): Promise<void>;
  list(options?: {
    readonly prefix?: string | undefined;
    readonly cursor?: string | null | undefined;
  }): Promise<Page<IsrDiskEntry>>;
}

export interface StorageIsrStoreOptions {
  readonly disk: IsrDisk;
  /** Every key this store writes starts with it. Default `isr/`. */
  readonly prefix?: string;
  /** Pages kept, across every replica. Default `DEFAULT_ISR_MAX_ENTRIES`. */
  readonly maxEntries?: number;
  /** Total stored bytes, across every replica. Default `DEFAULT_ISR_MAX_BYTES`. */
  readonly maxBytes?: number;
  /** How many writes, per process, between two sweeps of the bounds. Default 32. */
  readonly sweepEvery?: number;
  /** A fence token no other bump can have written. Injected so a test can name them. */
  readonly token?: () => string;
}

const NOT_FOUND = 'X_STORAGE_NOT_FOUND';
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Any string as a key segment: a path carries `?`, `&`, `%` and `/`, which a disk may not keep. */
const segment = (value: string): string =>
  encoder.encode(value).toBase64({ alphabet: 'base64url', omitPadding: true });
const unsegment = (value: string): string =>
  decoder.decode(Uint8Array.fromBase64(value, { alphabet: 'base64url' }));

export function storageIsrStore(options: StorageIsrStoreOptions): IsrStore {
  const { disk } = options;
  const prefix = options.prefix ?? 'isr/';
  // `finiteCount` at each default: a cap that arrived `NaN` (an unset env value) is no cap at all.
  const bounds = {
    maxEntries: finiteCount(
      'storageIsrStore',
      'maxEntries',
      options.maxEntries ?? DEFAULT_ISR_MAX_ENTRIES,
    ),
    maxBytes: finiteCount('storageIsrStore', 'maxBytes', options.maxBytes ?? DEFAULT_ISR_MAX_BYTES),
    sweepEvery: finiteCount('storageIsrStore', 'sweepEvery', options.sweepEvery ?? 32, 1),
  };
  const token = options.token ?? (() => crypto.randomUUID());
  const pages = `${prefix}page/`;
  const pageKey = (path: string): string => `${pages}${segment(path)}`;
  const fenceKey = (entity: string): string => `${prefix}fence/${segment(entity)}`;
  let writes = 0;

  /** The object's text, or `undefined` when there is none — the one refusal read as absence. */
  async function read(key: string): Promise<string | undefined> {
    try {
      return decoder.decode((await disk.get(key)).bytes);
    } catch (error) {
      if (isUltimateError(error) && error.code === NOT_FOUND) return undefined;
      throw error;
    }
  }

  async function listPages(): Promise<readonly IsrDiskEntry[]> {
    const all: IsrDiskEntry[] = [];
    let cursor: string | null = null;
    do {
      const page: Page<IsrDiskEntry> = await disk.list({ prefix: pages, cursor });
      all.push(...page.rows);
      cursor = page.nextCursor;
    } while (cursor !== null);
    return all;
  }

  /**
   * Oldest WRITE first — an object's `lastModified`, the one clock every replica shares. Not
   * least recently used: a read that wrote would turn every hit into a PUT. An object whose disk
   * reports no time goes first, so a listing that cannot age still stays bounded.
   */
  async function sweep(): Promise<void> {
    const held = [...(await listPages())].sort(
      (a, b) => (a.lastModified?.getTime() ?? 0) - (b.lastModified?.getTime() ?? 0),
    );
    let bytes = held.reduce((sum, entry) => sum + entry.size, 0);
    let count = held.length;
    for (const oldest of held) {
      if (count <= bounds.maxEntries && bytes <= bounds.maxBytes) break;
      await disk.delete(oldest.key);
      count -= 1;
      bytes -= oldest.size;
    }
  }

  async function set(entry: IsrEntry): Promise<void> {
    const body = encoder.encode(JSON.stringify(entry));
    // Kept, it would evict every other page and still be over the cap on its own. Measured on
    // the bytes written — the size the sweep counts — never on `html.length`.
    if (body.byteLength > bounds.maxBytes) {
      await disk.delete(pageKey(entry.path));
      return;
    }
    await disk.put(pageKey(entry.path), body, { contentType: 'application/json' });
    writes += 1;
    if (writes % bounds.sweepEvery === 1 || bounds.sweepEvery === 1) await sweep();
  }

  async function get(path: string): Promise<IsrEntry | undefined> {
    const text = await read(pageKey(path));
    if (text === undefined) return undefined;
    const entry = parseIsrEntry(text, path);
    if (entry === undefined) logger.warn('isr.store.entry_invalid', { path });
    return entry;
  }

  const reading = async (entities: readonly string[]): Promise<string> =>
    (await Promise.all(entities.map(async (entity) => (await read(fenceKey(entity))) ?? '0'))).join(
      ',',
    );

  /**
   * A bump writes a TOKEN no other bump wrote, never a counter: two replicas incrementing at once
   * would both write `n + 1`, and a slow one writing `n` back would make an older reading current
   * again. Any bump that starts after a reading leaves a value that reading never held.
   */
  const tagFence: IsrTagFence = {
    sample: reading,
    bump: async (entities) => {
      await Promise.all(
        entities.map((entity) => disk.put(fenceKey(entity), encoder.encode(token()))),
      );
    },
    /**
     * Write, then check again — a disk has no compare-and-put. A bust whose bump lands after the
     * second read began after this page was written, so its listing (`revalidateHeld` lists after
     * it bumps) finds the page and takes it down; one that lands before is seen here, and the page
     * is deleted again. Either way no page outlives a bust that its render predates.
     */
    setIfCurrent: async (entry, entities, sampled) => {
      if ((await reading(entities)) !== sampled) return false;
      await set(entry);
      if ((await reading(entities)) === sampled) return true;
      await disk.delete(pageKey(entry.path));
      return false;
    },
  };

  return {
    tagFence,
    get,
    set,
    markStale: async (path) => {
      const entry = await get(path);
      if (entry === undefined) return false;
      // A read-modify-write: a page regenerated between the two is marked stale too, which costs
      // one render and never serves a stale page as fresh.
      await disk.put(pageKey(path), encoder.encode(JSON.stringify({ ...entry, stale: true })), {
        contentType: 'application/json',
      });
      return true;
    },
    delete: (path) => disk.delete(pageKey(path)),
    paths: async () =>
      (await listPages()).map((entry) => unsegment(entry.key.slice(pages.length))).sort(),
  };
}
