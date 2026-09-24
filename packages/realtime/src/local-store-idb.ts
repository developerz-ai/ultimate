/**
 * The page's durable client store: persisted records and the one outbox, in IndexedDB, every entry
 * keyed by the principal it belongs to so one principal's cache can never restore into another's.
 * IndexedDB blocked (a private window, storage disabled) falls back to memory with ONE warning,
 * `X_LOCAL_STORE_UNAVAILABLE` — a page never breaks because it cannot remember.
 */

import type { ClientScope, RecordRows, Row } from '@ultimat3/core/page';
import { isJsonObject, renderThrowable, type UltimateError } from '@ultimat3/core/page';
import type { IdbDatabaseLike, IdbFactoryLike, IdbRequestLike } from './idb-types';
import type { QueueChange, QueuedMutation, QueueState } from './offline-queue';
import { LocalStoreUnavailableError } from './page-errors';

/** One persisted row, by record type and record key. */
export interface PersistedRow {
  readonly type: string;
  readonly key: string;
  readonly row: Row;
}

export interface LocalStore {
  readonly kind: 'indexeddb' | 'memory';
  /** Every persisted row of one scope: record type -> record key -> row. */
  rows(scope: string): Promise<ReadonlyMap<string, RecordRows>>;
  write(
    scope: string,
    puts: readonly PersistedRow[],
    deletes: readonly Omit<PersistedRow, 'row'>[],
  ): Promise<void>;
  queue(scope: string): Promise<QueueState | undefined>;
  /**
   * One change to one scope's outbox, BY KEY (`QueueChange`). It was `saveQueue(scope, state)`,
   * a whole-queue save — and two tabs of one user each saved their own copy, so the last save won
   * and the other tab's queued write was erased.
   */
  writeQueue(scope: string, change: QueueChange): Promise<void>;
  /** Everything of one scope — its rows AND its outbox. Sign-out, or any principal change. */
  wipe(scope: string): Promise<void>;
  /**
   * Everything of every scope but `keep` — rows and outboxes. The page boot's answer to a sign-out
   * by full navigation, which never calls `rescope()` and so never reaches `wipe`.
   */
  wipeOthers(keep: string): Promise<void>;
}

/**
 * The storage key of a principal, or `undefined` for an UNSCOPED page (rendered for nobody):
 * nothing is persisted there, because there is no principal to key it by. Prefixed so a principal
 * spelled `anon` can never share the anonymous visitor's rows.
 */
export function scopeKey(principal: ClientScope['principal']): string | undefined {
  if (principal === undefined) return undefined;
  return principal === null ? 'anon' : `p:${principal}`;
}

const RECORDS = 'records';
const OUTBOX = 'outbox';
/** JSON, never a joined string: a principal is opaque and may hold any separator. */
const rowKey = (scope: string, type: string, key: string): string =>
  JSON.stringify([scope, type, key]);
/** One queued mutation, and one scope's sequence floor — the outbox's two record shapes. */
const mutationKey = (scope: string, key: string): string => JSON.stringify([scope, 'm', key]);
const seqSlot = (scope: string): string => JSON.stringify([scope, 'seq']);

/** The scope an outbox key belongs to: `[scope, …]`, or a pre-22.0.0 whole-queue record `scope`. */
function outboxScopeOf(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  if (!raw.startsWith('[')) return raw;
  const parts: unknown = JSON.parse(raw);
  return Array.isArray(parts) && typeof parts[0] === 'string' ? parts[0] : undefined;
}

const byQueueOrder = (a: QueuedMutation, b: QueuedMutation): number =>
  a.seq - b.seq || a.enqueuedAt - b.enqueuedAt || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

/** Memory: tests, SSR, and the fallback when IndexedDB is unavailable. */
export class MemoryLocalStore implements LocalStore {
  readonly kind = 'memory';
  readonly #rows = new Map<string, PersistedRow & { readonly scope: string }>();
  readonly #queues = new Map<string, { mutations: Map<string, QueuedMutation>; nextSeq: number }>();

  async rows(scope: string): Promise<ReadonlyMap<string, RecordRows>> {
    return group([...this.#rows.values()].filter((entry) => entry.scope === scope));
  }
  async write(
    scope: string,
    puts: readonly PersistedRow[],
    deletes: readonly Omit<PersistedRow, 'row'>[],
  ): Promise<void> {
    for (const { type, key } of deletes) this.#rows.delete(rowKey(scope, type, key));
    for (const put of puts) this.#rows.set(rowKey(scope, put.type, put.key), { ...put, scope });
  }
  async queue(scope: string): Promise<QueueState | undefined> {
    const held = this.#queues.get(scope);
    if (held === undefined) return undefined;
    return {
      mutations: structuredClone([...held.mutations.values()]).sort(byQueueOrder),
      nextSeq: held.nextSeq,
    };
  }
  async writeQueue(scope: string, change: QueueChange): Promise<void> {
    const held = this.#queues.get(scope) ?? { mutations: new Map(), nextSeq: 1 };
    for (const key of change.deletes) held.mutations.delete(key);
    for (const put of change.puts) held.mutations.set(put.key, structuredClone(put));
    held.nextSeq = Math.max(held.nextSeq, change.nextSeq);
    this.#queues.set(scope, held);
  }
  async wipe(scope: string): Promise<void> {
    for (const [key, entry] of this.#rows) if (entry.scope === scope) this.#rows.delete(key);
    this.#queues.delete(scope);
  }
  async wipeOthers(keep: string): Promise<void> {
    for (const [key, entry] of this.#rows) if (entry.scope !== keep) this.#rows.delete(key);
    for (const scope of [...this.#queues.keys()]) if (scope !== keep) this.#queues.delete(scope);
  }
}

class IdbLocalStore implements LocalStore {
  readonly kind = 'indexeddb';
  constructor(private readonly db: IdbDatabaseLike) {}

  async rows(scope: string): Promise<ReadonlyMap<string, RecordRows>> {
    const tx = this.db.transaction(RECORDS, 'readonly');
    const store = tx.objectStore(RECORDS);
    const [keys, values] = await Promise.all([answer(store.getAllKeys()), answer(store.getAll())]);
    const found: PersistedRow[] = [];
    keys.forEach((raw, index) => {
      const parts: unknown = typeof raw === 'string' ? JSON.parse(raw) : undefined;
      const row = values[index];
      if (!Array.isArray(parts) || parts[0] !== scope || !isJsonObject(row)) return;
      found.push({ type: String(parts[1]), key: String(parts[2]), row });
    });
    return group(found);
  }
  async write(
    scope: string,
    puts: readonly PersistedRow[],
    deletes: readonly Omit<PersistedRow, 'row'>[],
  ): Promise<void> {
    const tx = this.db.transaction(RECORDS, 'readwrite');
    const store = tx.objectStore(RECORDS);
    for (const { type, key } of deletes) store.delete(rowKey(scope, type, key));
    for (const put of puts) store.put(put.row, rowKey(scope, put.type, put.key));
    await done(tx);
  }
  async queue(scope: string): Promise<QueueState | undefined> {
    // Read-WRITE: a pre-22.0.0 whole-queue record for this scope is converted in the same
    // transaction, so an upgrade keeps the writes a user queued on the previous version.
    const tx = this.db.transaction(OUTBOX, 'readwrite');
    const store = tx.objectStore(OUTBOX);
    // Both issued before either is awaited, and awaited one by one: the conversion below writes in
    // this transaction, and it must still be open when the reads land.
    const asked = [answer(store.getAllKeys()), answer(store.getAll())] as const;
    const keys = await asked[0];
    const values = await asked[1];
    const mutations = new Map<string, QueuedMutation>();
    let nextSeq = 1;
    let found = false;
    let converted = false;
    keys.forEach((raw, index) => {
      if (outboxScopeOf(raw) !== scope) return;
      found = true;
      const value = values[index];
      if (raw === scope) {
        const legacy = value as QueueState;
        for (const mutation of legacy.mutations) {
          mutations.set(mutation.key, mutation);
          store.put(mutation, mutationKey(scope, mutation.key));
        }
        nextSeq = Math.max(nextSeq, legacy.nextSeq);
        store.put(nextSeq, seqSlot(scope));
        store.delete(scope);
        converted = true;
      } else if (raw === seqSlot(scope)) {
        nextSeq = Math.max(nextSeq, typeof value === 'number' ? value : 1);
      } else {
        const mutation = value as QueuedMutation;
        mutations.set(mutation.key, mutation);
      }
    });
    // Awaited only when something was written: a transaction that issued nothing after its reads
    // has already completed, and a listener attached now would wait for an event that is gone.
    if (converted) await done(tx);
    return found ? { mutations: [...mutations.values()].sort(byQueueOrder), nextSeq } : undefined;
  }
  async writeQueue(scope: string, change: QueueChange): Promise<void> {
    const tx = this.db.transaction(OUTBOX, 'readwrite');
    const store = tx.objectStore(OUTBOX);
    const floor = await answer(store.get(seqSlot(scope)));
    for (const key of change.deletes) store.delete(mutationKey(scope, key));
    for (const put of change.puts) store.put(put, mutationKey(scope, put.key));
    store.put(Math.max(typeof floor === 'number' ? floor : 1, change.nextSeq), seqSlot(scope));
    await done(tx);
  }
  async wipe(scope: string): Promise<void> {
    const tx = this.db.transaction([RECORDS, OUTBOX], 'readwrite');
    const records = tx.objectStore(RECORDS);
    const keys = await answer(records.getAllKeys());
    for (const raw of keys) {
      if (typeof raw !== 'string') continue;
      const parts: unknown = JSON.parse(raw);
      if (Array.isArray(parts) && parts[0] === scope) records.delete(raw);
    }
    const outbox = tx.objectStore(OUTBOX);
    for (const raw of await answer(outbox.getAllKeys())) {
      if (outboxScopeOf(raw) === scope && typeof raw === 'string') outbox.delete(raw);
    }
    await done(tx);
  }
  async wipeOthers(keep: string): Promise<void> {
    const tx = this.db.transaction([RECORDS, OUTBOX], 'readwrite');
    const records = tx.objectStore(RECORDS);
    const outbox = tx.objectStore(OUTBOX);
    const [rowKeys, queueKeys] = await Promise.all([
      answer(records.getAllKeys()),
      answer(outbox.getAllKeys()),
    ]);
    for (const raw of rowKeys) {
      if (typeof raw !== 'string') continue;
      const parts: unknown = JSON.parse(raw);
      if (Array.isArray(parts) && parts[0] !== keep) records.delete(raw);
    }
    for (const raw of queueKeys) {
      const scope = outboxScopeOf(raw);
      if (typeof raw === 'string' && scope !== undefined && scope !== keep) outbox.delete(raw);
    }
    await done(tx);
  }
}

export interface OpenLocalStoreOptions {
  /** Default `globalThis.indexedDB`, read at call time. */
  readonly indexedDB?: IdbFactoryLike | undefined;
  /** Where the one fallback warning goes. Default `console.warn`. */
  readonly warn?: ((error: UltimateError) => void) | undefined;
  readonly name?: string | undefined;
}

/** IndexedDB when the page has it and it opens; memory, warned once, when it does not. */
export async function openLocalStore(options: OpenLocalStoreOptions = {}): Promise<LocalStore> {
  // The browser's `IDBFactory` IS this shape at runtime; its DOM typings (event-typed handlers)
  // are wider than the slice `idb-types.ts` declares, so the ambient value is narrowed once here.
  const ambient: unknown = Reflect.get(globalThis, 'indexedDB');
  const factory = options.indexedDB ?? (ambient as IdbFactoryLike | undefined);
  const warn = options.warn ?? ((error: UltimateError) => console.warn(error));
  if (factory === undefined) {
    warn(new LocalStoreUnavailableError({ reason: 'this runtime has no indexedDB' }));
    return new MemoryLocalStore();
  }
  try {
    return new IdbLocalStore(await openDatabase(factory, options.name ?? 'ultimate-client'));
  } catch (error) {
    warn(
      new LocalStoreUnavailableError({
        reason: `indexedDB.open failed: ${renderThrowable(error)}`,
      }),
    );
    return new MemoryLocalStore();
  }
}

function openDatabase(factory: IdbFactoryLike, name: string): Promise<IdbDatabaseLike> {
  return new Promise((resolve, reject) => {
    const request = factory.open(name, 1);
    request.onupgradeneeded = (): void => {
      const db = request.result;
      if (!db.objectStoreNames.contains(RECORDS)) db.createObjectStore(RECORDS);
      if (!db.objectStoreNames.contains(OUTBOX)) db.createObjectStore(OUTBOX);
    };
    request.onsuccess = (): void => resolve(request.result);
    request.onerror = (): void => reject(request.error);
    request.onblocked = (): void => reject(request.error ?? 'blocked by another open tab');
  });
}

function answer<T>(request: IdbRequestLike<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = (): void => resolve(request.result);
    request.onerror = (): void => reject(request.error);
  });
}

function done(tx: {
  oncomplete: (() => void) | null;
  onerror: (() => void) | null;
  onabort: (() => void) | null;
  error: unknown;
}): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = (): void => resolve();
    tx.onerror = (): void => reject(tx.error);
    // A quota refusal ABORTS the transaction and fires nothing else, so a store that listened only
    // for `complete` and `error` left `write`, `writeQueue`, `flush` and `enqueue` pending forever.
    tx.onabort = (): void =>
      reject(tx.error ?? new DOMException('the transaction was aborted', 'AbortError'));
  });
}

function group(entries: readonly PersistedRow[]): ReadonlyMap<string, RecordRows> {
  const out = new Map<string, Record<string, Row>>();
  for (const { type, key, row } of entries) {
    const rows = out.get(type) ?? (Object.create(null) as Record<string, Row>);
    Object.defineProperty(rows, key, { value: row, enumerable: true });
    out.set(type, rows);
  }
  return out;
}

const PAGE_KEY: unique symbol = Symbol.for('ultimate.local-store');
type PageHost = { [PAGE_KEY]?: Promise<LocalStore> };

/**
 * The page's ONE durable store, opened once per tab whichever island asks first — the persister and
 * the outbox share it, so a wipe on a principal change reaches both. On `globalThis`, like the
 * record store, because every island bundle carries its own copy of this module.
 */
export function pageLocalStore(): Promise<LocalStore> {
  const host = globalThis as PageHost;
  const existing = host[PAGE_KEY];
  if (existing !== undefined) return existing;
  const opened = openLocalStore();
  Object.defineProperty(host, PAGE_KEY, { value: opened, configurable: true });
  return opened;
}
