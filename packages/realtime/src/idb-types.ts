/**
 * The slice of IndexedDB `local-store-idb.ts` touches, as structural types: the browser's
 * `indexedDB` satisfies them and so does `idb-fake.ts`, so the store is tested against the same
 * surface it runs on without a DOM shim.
 */

export interface IdbRequestLike<T> {
  result: T;
  error: unknown;
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
  onupgradeneeded?: (() => void) | null;
  onblocked?: (() => void) | null;
}

export interface IdbStoreLike {
  put(value: unknown, key: string): IdbRequestLike<unknown>;
  delete(key: string): IdbRequestLike<unknown>;
  getAll(): IdbRequestLike<unknown[]>;
  getAllKeys(): IdbRequestLike<unknown[]>;
}

export interface IdbTransactionLike {
  oncomplete: (() => void) | null;
  onerror: (() => void) | null;
  error: unknown;
  objectStore(name: string): IdbStoreLike;
}

export interface IdbDatabaseLike {
  readonly objectStoreNames: { contains(name: string): boolean };
  createObjectStore(name: string): unknown;
  transaction(
    names: string | readonly string[],
    mode?: 'readonly' | 'readwrite',
  ): IdbTransactionLike;
}

export interface IdbFactoryLike {
  open(name: string, version: number): IdbRequestLike<IdbDatabaseLike>;
}
