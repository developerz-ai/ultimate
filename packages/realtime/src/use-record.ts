// One record, by type and key, out of the page's store — the same object every island showing it
// holds, moved once by whichever write lands first (an HTTP answer, a socket frame, an optimistic
// twin). Imports no socket: an island that only reads records ships none of the lifecycle.

import type { AsyncState, Row } from '@ultimat3/core/page';
import { pageStore } from './page-store';
import { isServerRender, signalFor } from './reactivity';
import { recordKey } from './record-store';

/**
 * A callable `AsyncState`: `pending` until the record first arrives, `ready` from then on —
 * `ready` with `undefined` once the server removed it, so a deleted record is a settled answer
 * and never a skeleton forever. `release()` lets go; the caller owns it (Solid: `onCleanup`).
 */
export type RecordAccessor<R extends object = Row> = (() => AsyncState<R | undefined>) & {
  release(): void;
  [Symbol.dispose](): void;
};

const PENDING: AsyncState<never> = Object.freeze({ status: 'pending' });

/** Nothing was held, so nothing is released — and a teardown never fails a render. */
const releaseNothing = (): void => undefined;

export function useRecord<R extends object = Row>(type: string, key: string): RecordAccessor<R> {
  const signal = signalFor('useRecord');
  if (isServerRender()) {
    // The record arrives in a browser this render does not have: the page's own loading branch.
    return Object.assign((): AsyncState<R | undefined> => PENDING, {
      release: releaseNothing,
      [Symbol.dispose]: releaseNothing,
    });
  }
  const store = pageStore();
  const [version, setVersion] = signal(0);
  const target = recordKey(type, key);
  store.retain(type, key);
  // Seen once it has ever been there — read or not — so a removal after it is a settled answer.
  let seen = store.peek(type, key) !== undefined;
  const unsubscribe = store.subscribe((changed) => {
    if (!changed.has(target)) return;
    if (store.peek(type, key) !== undefined) seen = true;
    setVersion(version() + 1);
  });
  const read = (): AsyncState<R | undefined> => {
    version();
    // The store holds JSON rows; the caller names the entity row type it reads them as.
    const row = store.peek(type, key) as R | undefined;
    if (row !== undefined) seen = true;
    return row === undefined && !seen ? PENDING : { status: 'ready', data: row };
  };
  let held = true;
  const release = (): void => {
    if (!held) return;
    held = false;
    unsubscribe();
    store.release(type, key);
  };
  return Object.assign(read, { release, [Symbol.dispose]: release });
}

/** A callable `AsyncState` over several records, in the order their keys were given. */
export type RecordsAccessor<R extends object = Row> = (() => AsyncState<readonly R[]>) & {
  release(): void;
  [Symbol.dispose](): void;
};

/**
 * Several records of one type, by key — the same store objects `useRecord` hands out. `pending`
 * until the first of them arrives; then `ready` with those present, in key order: a record the
 * server removed simply drops out, and a list is never shown as its skeleton again.
 */
export function useRecords<R extends object = Row>(
  type: string,
  keys: readonly string[],
): RecordsAccessor<R> {
  const signal = signalFor('useRecords');
  if (isServerRender()) {
    return Object.assign((): AsyncState<readonly R[]> => PENDING, {
      release: releaseNothing,
      [Symbol.dispose]: releaseNothing,
    });
  }
  const store = pageStore();
  const [version, setVersion] = signal(0);
  const targets = new Set(keys.map((key) => recordKey(type, key)));
  const present = (): R[] => {
    const out: R[] = [];
    // The store holds JSON rows; the caller names the entity row type it reads them as.
    for (const key of keys) {
      const row = store.peek(type, key) as R | undefined;
      if (row !== undefined) out.push(row);
    }
    return out;
  };
  store.batch(() => {
    for (const key of keys) store.retain(type, key);
  });
  let seen = present().length > 0;
  const unsubscribe = store.subscribe((changed) => {
    if (![...changed].some((key) => targets.has(key))) return;
    if (present().length > 0) seen = true;
    setVersion(version() + 1);
  });
  const read = (): AsyncState<readonly R[]> => {
    version();
    const rows = present();
    if (rows.length > 0) seen = true;
    return !seen ? PENDING : { status: 'ready', data: rows };
  };
  let held = true;
  const release = (): void => {
    if (!held) return;
    held = false;
    unsubscribe();
    store.batch(() => {
      for (const key of keys) store.release(type, key);
    });
  };
  return Object.assign(read, { release, [Symbol.dispose]: release });
}
