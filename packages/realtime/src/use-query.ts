// The ONE read hook. Live-ness is the query's, not the hook's: a live ref subscribes over the
// page socket, any other is one HTTP read through `@ultimat3/query`'s client (and so through
// core's one transport). Either way a list is an ORDER of keys and the rows are the page store's,
// so a record updated anywhere re-renders every list showing it without refetching the list.

import { type AsyncState, isSuperseded, type RecordEnvelope, type Row } from '@ultimat3/core/page';
import { queryClientMethodFor } from '@ultimat3/query/client';
import type { LiveHandle } from './client-contract';
import type { JsonValue } from './json';
import { pageSocket } from './page-socket';
import { pageStore } from './page-store';
import { isServerRender, signalFor } from './reactivity';
import { type RecordStore, recordKey } from './record-store';

/**
 * What a browser may name a query by: its registered name and two facts the server declaration
 * holds. Never the query VALUE — importing one drags its whole read path into the island
 * (measured 698,801 B for the dummy feed). The type has no server field, which is the rule.
 */
export interface QueryRef {
  readonly name: string;
  /** `live: true` on the declaration: rows arrive and move over the page socket. */
  readonly live?: boolean;
  /**
   * The record type (entity name) a NON-live read's rows are. Named, the list is the keys of the
   * answer's `records[type]` — store records any write moves; omitted, or answered with no records
   * envelope, the list holds its rows itself and only a refetch moves them. A live read needs none.
   */
  readonly entity?: string;
}

/** A callable `AsyncState` over the list, plus the two things a caller does to it. */
export type QueryAccessor<R extends object = Row> = (() => AsyncState<readonly R[]>) & {
  /** Read again from the first page, keeping the current rows on screen (`refreshing`). */
  refetch(): void;
  /**
   * The next page, appended — from the cursor the server's last page answered with. A no-op on a
   * live read, on a read with no `first`, and once the server said there is no next page.
   */
  more(): void;
  /** Whether the server's last page said another follows. Reactive, like the accessor itself. */
  hasMore(): boolean;
  release(): void;
  [Symbol.dispose](): void;
};

const PENDING: AsyncState<never> = Object.freeze({ status: 'pending' });
const nothing = (): void => undefined;

/**
 * `input` is read ONCE, at call time: there is no reactive runtime here to re-run it, and a
 * silently stale subscription is worse than a new call. A changed input is a new `useQuery`.
 */
export interface QueryOptions {
  /** Read in pages of this many rows (`query.page`); `more()` appends the next. Non-live only. */
  readonly first?: number;
}

export function useQuery<R extends object = Row>(
  ref: QueryRef,
  input: JsonValue,
  options: QueryOptions = {},
): QueryAccessor<R> {
  const signal = signalFor('useQuery');
  if (isServerRender()) {
    return Object.assign((): AsyncState<readonly R[]> => PENDING, {
      refetch: nothing,
      more: nothing,
      hasMore: () => false,
      release: nothing,
      [Symbol.dispose]: nothing,
    });
  }
  const [version, setVersion] = signal(0);
  const bump = (): void => setVersion(version() + 1);
  return ref.live === true
    ? liveAccessor<R>(pageSocket('useQuery').subscribeLive<R>(ref, input), version, bump)
    : readAccessor<R>(pageStore(), ref, input, options, version, bump);
}

function liveAccessor<R extends object>(
  handle: LiveHandle<R>,
  version: () => number,
  bump: () => void,
): QueryAccessor<R> {
  // Seen once a snapshot landed — read or not — so a drop after it keeps the rows on screen.
  let seen = handle.state() === 'live';
  const off = handle.onChange(() => {
    if (handle.state() === 'live') seen = true;
    bump();
  });
  const read = (): AsyncState<readonly R[]> => {
    version();
    const state = handle.state();
    if (state === 'failed') return { status: 'failed', error: handle.error() };
    if (state === 'live') {
      seen = true;
      return { status: 'ready', data: handle.rows() };
    }
    // Loading, stale or offline: what was shown stays shown, marked busy — never torn down.
    return seen ? { status: 'refreshing', data: handle.rows() } : PENDING;
  };
  const release = (): void => {
    off();
    handle.unsubscribe();
  };
  return Object.assign(read, {
    refetch: nothing,
    more: nothing,
    hasMore: () => false,
    release,
    [Symbol.dispose]: release,
  });
}

function readAccessor<R extends object>(
  store: RecordStore,
  ref: QueryRef,
  input: JsonValue,
  options: QueryOptions,
  version: () => number,
  bump: () => void,
): QueryAccessor<R> {
  const type = ref.entity;
  const method = queryClientMethodFor(ref.name, { baseUrl: '' });
  let state: AsyncState<readonly Row[]> = PENDING;
  /** Record keys in answer order when the rows are records; the rows themselves when not. */
  let keys: readonly string[] = [];
  let own: readonly Row[] = [];
  let released = false;
  let generation = 0;
  /** The cursor the server's last page answered with; `null` = no next page (or not paged). */
  let after: string | null = null;
  const off =
    type === undefined
      ? nothing
      : store.subscribe((changed) => {
          if (keys.some((key) => changed.has(recordKey(type, key)))) bump();
        });

  const rows = (): readonly Row[] => {
    if (type === undefined || keys.length === 0) return own;
    const out: Row[] = [];
    for (const key of keys) {
      const row = store.peek(type, key);
      if (row !== undefined) out.push(row);
    }
    return out;
  };

  const hold = (next: readonly string[]): void => {
    if (type === undefined) return;
    store.batch(() => {
      for (const key of next) store.retain(type, key);
      for (const key of keys) store.release(type, key);
    });
  };

  /**
   * One answer: its rows, and — when the server sent the records envelope — the KEYS of this
   * read's records in answer order (`records[type]`, which `rowsOf` fills first-seen = data order).
   * The browser never derives a key: an answer with no records envelope holds its rows itself.
   */
  const fetch = (append: boolean): Promise<{ rows: readonly Row[]; keys: string[] | null }> => {
    let keysOf: string[] | null = null;
    const onEnvelope = (envelope: RecordEnvelope): void => {
      const records = type === undefined ? undefined : envelope.records?.[type];
      keysOf = records === undefined ? null : Object.keys(records);
    };
    const answered = (rows: readonly Row[]) => ({ rows, keys: keysOf });
    if (options.first === undefined) {
      return (method(input, { onEnvelope }) as Promise<readonly Row[]>).then(answered);
    }
    const controls =
      append && after !== null ? { first: options.first, after } : { first: options.first };
    return method.page(input, controls, { onEnvelope }).then((page) => {
      after = page.hasNextPage ? page.endCursor : null;
      return answered(page.rows as readonly Row[]);
    });
  };

  const load = (append = false): void => {
    const mine = ++generation;
    if (state.status === 'ready') state = { status: 'refreshing', data: rows() };
    bump();
    fetch(append).then(
      (answer) => {
        if (released || mine !== generation) return;
        if (type === undefined || answer.keys === null) {
          // Not records — no type named, or no envelope: the list holds its own rows.
          own = append ? [...own, ...answer.rows] : answer.rows;
          if (!append) {
            hold([]);
            keys = [];
          }
        } else {
          // The transport adopted the envelope's records before this ran; the window is their keys.
          const answered = answer.keys;
          const next = append
            ? [...keys, ...answered.filter((key) => !keys.includes(key))]
            : answered;
          hold(next);
          keys = next;
          if (!append) own = [];
        }
        state = { status: 'ready', data: [] };
        bump();
      },
      (error: unknown) => {
        if (released || mine !== generation) return;
        // The page changed principal under this read: its answer was the previous one's, and the
        // store it would have landed in is already empty. Read again, as the new principal.
        if (isSuperseded(error)) {
          load();
          return;
        }
        state = { status: 'failed', error };
        bump();
      },
    );
  };

  load();
  const read = (): AsyncState<readonly R[]> => {
    version();
    if (state.status === 'pending' || state.status === 'failed') return state;
    // Rows are typed by the caller's query; the store holds them as JSON rows.
    const data = rows() as readonly R[];
    return state.status === 'refreshing'
      ? { status: 'refreshing', data }
      : { status: 'ready', data };
  };
  const release = (): void => {
    if (released) return;
    released = true;
    off();
    hold([]);
    keys = [];
  };
  return Object.assign(read, {
    refetch: () => {
      after = null;
      load();
    },
    more: () => {
      if (after !== null && state.status === 'ready') load(true);
    },
    hasMore: () => {
      version();
      return after !== null;
    },
    release,
    [Symbol.dispose]: release,
  });
}
