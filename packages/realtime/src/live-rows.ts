// One live subscription's window over the page's record store. The registration owns the ORDER
// (its ids) and the store owns the VALUES — which is what makes post #7 one object however many
// queries returned it, and what makes a write through any of them reach all of them.

import type { Row } from '@ultimat3/core/page';
import { orderAfterPatches } from './apply-patches';
import type { LiveCursor } from './cursor';
import type { JsonValue, RowPatch } from './json';
import { type RecordKey, type RecordStore, recordKey } from './record-store';

export type LiveState = 'loading' | 'live' | 'stale' | 'offline' | 'failed';

/** One live query this client holds. Mutable: the ids and cursor a frame advances live here. */
export interface Registration {
  readonly sid: string;
  readonly name: string;
  readonly input: JsonValue;
  /** The record type the server named for this window; `unnamedType(name)` until it does. */
  type: string;
  /** Membership and order. The values are the store's — never a second copy of them. */
  ids: readonly string[];
  cursor: LiveCursor | null;
  state: LiveState;
  /** What the node answered when it refused this subscription. Set with `state: 'failed'`. */
  error: unknown;
  /** Called after anything a reader of this window renders has moved. */
  readonly notify: () => void;
}

/**
 * Where a window's rows live when the server named no record type: `?` starts no entity name, so
 * two unnamed windows sharing an id never merge two entities' rows. Not a record type — only a
 * snapshot from a node that cannot name the entity lands here.
 */
export function unnamedType(queryName: string): string {
  return `?query:${queryName}`;
}

/**
 * Every open window over the one store. It is the only writer of `Registration.ids`, so the
 * retain/release pairs that keep the store from growing without end cannot be forgotten.
 */
export class RowWindows {
  readonly #store: RecordStore;
  /** The window a write is running for, so its own listener does not notify it twice. */
  #writing: Registration | null = null;

  constructor(store: RecordStore) {
    this.#store = store;
  }

  /** Render this registration out of the store; the returned close releases every row it held. */
  open(registration: Registration): () => void {
    const unsubscribe = this.#store.subscribe((changed) => {
      if (this.#writing === registration) return;
      if (holds(registration, changed)) registration.notify();
    });
    return () => {
      unsubscribe();
      this.#store.batch(() => {
        for (const id of registration.ids) this.#store.release(registration.type, id);
        registration.ids = [];
      });
    };
  }

  /** A snapshot: server truth for the whole window, under the record type the server named. */
  snapshot(
    registration: Registration,
    type: string | null,
    rows: readonly Row[],
    keys?: readonly string[],
  ): void {
    const next = type ?? registration.type;
    // The server's record key where it sent one; a row's `id` IS its key everywhere else.
    const keyed = rows.map((row, index) => [keys?.[index] ?? String(row['id']), row] as const);
    this.#reseat(
      registration,
      next,
      keyed.map(([id]) => id),
      () => {
        for (const [id, row] of keyed) this.#store.merge(next, id, row);
      },
    );
  }

  /** A patch list: values merged into the store, membership and order folded over the ids. */
  patch(registration: Registration, sent: readonly RowPatch[]): void {
    const type = registration.type;
    // A window holds RECORD keys: a patch the server keyed is folded under its key, not its id.
    const patches = sent.map((patch) =>
      patch.key === undefined ? patch : { ...patch, id: patch.key },
    );
    // A `delete` is this window losing the row, never the store losing it: another holder keeps it.
    this.#reseat(registration, type, orderAfterPatches(registration.ids, patches), (held) => {
      for (const patch of patches) {
        if (patch.op === 'delete' || patch.row === null) continue;
        if (held.has(patch.id)) this.#store.merge(type, patch.id, patch.row);
      }
    });
  }

  /** The window's rows, in its order. Absent ids are skipped — a released row renders as gone. */
  rows(registration: Registration): readonly Row[] {
    const out: Row[] = [];
    for (const id of registration.ids) {
      const row = this.#store.peek(registration.type, id);
      if (row !== undefined) out.push(row);
    }
    return out;
  }

  /**
   * Move the window to `nextIds` under `type`, writing values in between — one batch, one notify.
   * The retain comes before the write and the release after it, so a row this window keeps across
   * the move never reaches zero holds and is evicted out from under the value it is being given.
   */
  #reseat(
    registration: Registration,
    type: string,
    nextIds: readonly string[],
    write: (held: ReadonlySet<string>) => void,
  ): void {
    const previous = this.#writing;
    this.#writing = registration;
    try {
      this.#store.batch(() => {
        for (const id of nextIds) this.#store.retain(type, id);
        write(new Set(nextIds));
        for (const id of registration.ids) this.#store.release(registration.type, id);
        registration.type = type;
        registration.ids = nextIds;
      });
    } finally {
      this.#writing = previous;
    }
    registration.notify();
  }
}

function holds(registration: Registration, changed: ReadonlySet<RecordKey>): boolean {
  for (const id of registration.ids) {
    if (changed.has(recordKey(registration.type, id))) return true;
  }
  return false;
}
