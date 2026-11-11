// `memoFlights(ctx, name)`: one named namespace of reads in flight inside a ctx's request memo —
// the store and byte bound `memoTier` and `memoPerRequest` use. It exists for `@ultimat3/query`,
// which is handed its ctx instead of reading the ALS one and keeps `fresh` reads that replace.

import { holdValue, storeOf } from './memo-store';

/** A ctx's reads under one name: joinable while pending, dropped on rejection, evicted oldest. */
export interface MemoFlights {
  get(key: string): Promise<unknown> | undefined;
  has(key: string): boolean;
  /** Publish `flight` as the newest answer for `key`, replacing whatever was held. */
  publish(key: string, flight: Promise<unknown>): void;
  /** Bytes the WHOLE ctx memo holds (every namespace), against `MEMO_MAX_BYTES`. */
  readonly bytes: number;
}

export function memoFlights(ctx: object, name: string): MemoFlights {
  const store = storeOf(ctx, true);
  const namespace = `\u0000flight:${name}\u0000`;
  const held = (key: string): Promise<unknown> | undefined => {
    const entry = store.entries.get(namespace + key);
    return entry?.kind === 'value' ? (entry.value as Promise<unknown>) : undefined;
  };
  return {
    get: held,
    has: (key) => held(key) !== undefined,
    publish: (key, flight) => holdValue(store, namespace + key, flight),
    get bytes() {
      return store.bytes;
    },
  };
}
