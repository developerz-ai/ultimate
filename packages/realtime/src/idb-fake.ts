/**
 * An in-memory IndexedDB with exactly the surface `local-store-idb.ts` uses — open with an
 * upgrade, one transaction over named stores, `put` / `delete` / `getAll` / `getAllKeys` — and
 * IndexedDB's own asynchrony: every request answers on a later microtask and a transaction
 * completes after its last request. Bun ships no IndexedDB, and no dependency is worth a test seam.
 * Values are structured-cloned in and out, as the real one does.
 */

import type { IdbDatabaseLike, IdbFactoryLike, IdbRequestLike, IdbStoreLike } from './idb-types';

type Tables = Map<string, Map<string, unknown>>;

export interface FakeIdbOptions {
  /** `open` fails, as it does in a private window or with storage blocked. */
  readonly blocked?: boolean;
  /**
   * Every write ABORTS its transaction, as a quota refusal does: `abort` fires and nothing else —
   * no `complete`, no transaction `error` event. Read at write time, so a test can flip it.
   */
  quotaExceeded?: boolean;
}

/** A fresh, empty database server. Share one instance to simulate a reload over the same disk. */
export function fakeIndexedDb(options: FakeIdbOptions = {}): IdbFactoryLike {
  const databases = new Map<string, { version: number; tables: Tables }>();
  return {
    open(name: string, version: number): IdbRequestLike<IdbDatabaseLike> {
      const request = pendingRequest<IdbDatabaseLike>();
      queueMicrotask(() => {
        if (options.blocked === true) {
          request.fail(new DOMException('The operation is insecure.', 'SecurityError'));
          return;
        }
        const known = databases.get(name) ?? { version: 0, tables: new Map() };
        databases.set(name, known);
        const db = database(known.tables, options);
        request.result = db;
        if (known.version < version) {
          known.version = version;
          request.onupgradeneeded?.();
        }
        request.onsuccess?.();
      });
      return request;
    },
  };
}

function database(tables: Tables, options: FakeIdbOptions): IdbDatabaseLike {
  return {
    objectStoreNames: { contains: (name: string): boolean => tables.has(name) },
    createObjectStore: (name: string): void => {
      tables.set(name, new Map());
    },
    transaction(names: string | readonly string[]) {
      let open = 0;
      let failed = false;
      const tx = {
        oncomplete: null as (() => void) | null,
        onerror: null as (() => void) | null,
        onabort: null as (() => void) | null,
        error: null as unknown,
        objectStore: (name: string): IdbStoreLike => store(name),
      };
      const abort = (): void => {
        if (failed) return;
        failed = true;
        tx.error = new DOMException('The quota has been exceeded.', 'QuotaExceededError');
        queueMicrotask(() => tx.onabort?.());
      };
      const settleLater = (): void => {
        queueMicrotask(() => {
          if (open > 0 || failed) return;
          tx.oncomplete?.();
        });
      };
      const run = <T>(work: () => T): IdbRequestLike<T> => {
        const request = pendingRequest<T>();
        open += 1;
        queueMicrotask(() => {
          open -= 1;
          request.result = work();
          request.onsuccess?.();
          settleLater();
        });
        return request;
      };
      const store = (name: string): IdbStoreLike => {
        const allowed = typeof names === 'string' ? [names] : names;
        const table = tables.get(name);
        if (!allowed.includes(name) || table === undefined) {
          throw new DOMException(`no object store ${name}`, 'NotFoundError');
        }
        const sorted = (): [string, unknown][] =>
          [...table].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
        return {
          get: (key) => run(() => structuredClone(table.get(key))),
          put: (value, key) =>
            run(() => {
              if (options.quotaExceeded === true) {
                abort();
                return;
              }
              table.set(key, structuredClone(value));
            }),
          delete: (key) => run(() => void table.delete(key)),
          getAll: () => run(() => sorted().map(([, value]) => structuredClone(value))),
          getAllKeys: () => run(() => sorted().map(([key]) => key)),
        };
      };
      settleLater();
      return tx;
    },
  };
}

type PendingRequest<T> = IdbRequestLike<T> & { fail(error: unknown): void };

function pendingRequest<T>(): PendingRequest<T> {
  const request: PendingRequest<T> = {
    result: undefined as T,
    error: null,
    onsuccess: null,
    onerror: null,
    onupgradeneeded: null,
    onblocked: null,
    fail(error: unknown): void {
      request.error = error;
      request.onerror?.();
    },
  };
  return request;
}
