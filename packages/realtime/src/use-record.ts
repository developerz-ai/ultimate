// One record, by type and key, out of the page's store — the same object every island showing it
// holds, moved once by whichever write lands first (an HTTP answer, a socket frame, an optimistic
// twin). A reader of the page runtime's store: an island that only reads records ships the hook and
// none of the store, the socket or its lifecycle.

import type { AsyncState, Row } from '@ultimat3/core/page';
import { pageStore } from './page-store';
import { isServerRender, signalFor } from './reactivity';
import { type RecordStore, recordKey } from './record-store';

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
  const store = pageStore('useRecord');
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

/** A callable `AsyncState` over several records of one type. */
export type RecordsAccessor<R extends object = Row> = (() => AsyncState<readonly R[]>) & {
  release(): void;
  [Symbol.dispose](): void;
};

/**
 * Which records of a type a whole-type `useRecords` shows, and in what order. Both run on every
 * change to that type, in the browser, over rows already on the page: pure, and cheap.
 */
export interface RecordSelection<R extends object = Row> {
  /** Keep a record only when this answers `true`. Absent: every record of the type. */
  readonly where?: (record: R) => boolean;
  /** Absent: by record key, ascending — creation order for a uuid v7 key. */
  readonly order?: (a: R, b: R) => number;
}

/**
 * Records of one type out of the page store — the same objects `useRecord` hands out.
 *
 * - **By key** (`useRecords('posts', keys)`): `pending` until the first of them arrives, then
 *   `ready` with those present, in key order; a record the server removed drops out.
 * - **The whole type** (`useRecords('runs', {})`, `useRecords('runs', { where, order })`): every record
 *   of it the store holds — HTTP answers, live patches, a channel's `records` frames and pending
 *   optimistic writes alike — `ready` from the first read (an empty store is an empty list; whether
 *   the page has caught up is the channel's or the query's to say). A record a frame adopts joins
 *   the list; none is evicted while it is held. The channel-records counterpart of a live window.
 */
export function useRecords<R extends object = Row>(
  type: string,
  select: readonly string[] | RecordSelection<R>,
): RecordsAccessor<R> {
  const signal = signalFor('useRecords');
  if (isServerRender()) {
    return Object.assign((): AsyncState<readonly R[]> => PENDING, {
      release: releaseNothing,
      [Symbol.dispose]: releaseNothing,
    });
  }
  const store = pageStore('useRecords');
  const [version, setVersion] = signal(0);
  const bump = (): void => setVersion(version() + 1);
  return isKeyList(select)
    ? byKeys<R>(store, type, select, version, bump)
    : ofType<R>(store, type, select, version, bump);
}

// `Array.isArray` narrows a `readonly` array union to `any[]`; this keeps the element type.
const isKeyList = (value: unknown): value is readonly string[] => Array.isArray(value);

function byKeys<R extends object>(
  store: RecordStore,
  type: string,
  keys: readonly string[],
  version: () => number,
  bump: () => void,
): RecordsAccessor<R> {
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
    bump();
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

function ofType<R extends object>(
  store: RecordStore,
  type: string,
  selection: RecordSelection<R>,
  version: () => number,
  bump: () => void,
): RecordsAccessor<R> {
  const prefix = `${type}:`;
  const { where, order } = selection;
  store.retainType(type);
  // Recomputed once per change to this type, never per read: the same answer back is what tells
  // a fine-grained renderer nothing moved.
  let answer: AsyncState<readonly R[]> | null = null;
  let answered = -1;
  const unsubscribe = store.subscribe((changed) => {
    for (const rk of changed) {
      if (!rk.startsWith(prefix)) continue;
      bump();
      return;
    }
  });
  const read = (): AsyncState<readonly R[]> => {
    const at = version();
    if (answer !== null && answered === at) return answer;
    // The store holds JSON rows; the caller names the entity row type it reads them as.
    const keyed = store.keyed(type) as readonly (readonly [string, R])[];
    const kept = where === undefined ? [...keyed] : keyed.filter(([, row]) => where(row));
    const rows =
      order === undefined
        ? kept.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, row]) => row)
        : kept.map(([, row]) => row).sort(order);
    answer = { status: 'ready', data: rows };
    answered = at;
    return answer;
  };
  let held = true;
  const release = (): void => {
    if (!held) return;
    held = false;
    unsubscribe();
    store.releaseType(type);
  };
  return Object.assign(read, { release, [Symbol.dispose]: release });
}
