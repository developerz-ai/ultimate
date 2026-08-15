// One live subscription's window, projected out of the identity map. The registration owns the
// ORDER (its ids) and the map owns the VALUES — which is what makes post #7 one object however
// many queries returned it, and what makes a write through any of them reach all of them.

import { orderAfterPatches } from './apply-patches';
import type { LiveCursor } from './cursor';
import { type IdentityMap, type RowKey, type RowScope, rowKey } from './identity-map';
import type { JsonValue, Row, RowPatch } from './json';

export type LiveState = 'loading' | 'live' | 'stale' | 'offline';

/** One live query this client holds. Mutable: the ids and cursor a frame advances live here. */
export interface Registration {
  readonly sid: string;
  readonly name: string;
  readonly input: JsonValue;
  readonly setRows: (rows: readonly Row[]) => void;
  readonly setState: (state: LiveState) => void;
  readonly setCursor: (cursor: LiveCursor | null) => void;
  /** Where this window's rows live in the map: the entity the server named, or a private scope. */
  scope: RowScope;
  /** Membership and order. The values are the map's — never a second copy of them. */
  ids: readonly string[];
  cursor: LiveCursor | null;
}

/**
 * Every open window over one identity map. It is the only writer of `Registration.ids`, so the
 * retain/release pairs that keep the map from growing without end cannot be forgotten by a caller.
 */
export class RowWindows {
  readonly #identity: IdentityMap;
  /** The window a write is running for, so its own listener does not emit the same rows twice. */
  #writing: Registration | null = null;

  constructor(identity: IdentityMap) {
    this.#identity = identity;
  }

  /**
   * Start rendering this registration out of the map. The returned close releases its rows and
   * drops its listener — an unsubscribed component must stop holding rows and stop hearing about
   * them in the same call, or one of the two outlives the other.
   */
  open(registration: Registration): () => void {
    const unsubscribe = this.#identity.subscribe((changed) => {
      if (this.#writing === registration) return;
      if (!holds(registration, changed)) return;
      this.#emit(registration);
    });
    return () => {
      unsubscribe();
      this.#identity.batch(() => {
        for (const id of registration.ids) this.#identity.release(registration.scope, id);
        registration.ids = [];
      });
    };
  }

  /**
   * A snapshot: server truth for the whole window. `entity` is the scope the server named for this
   * subscription — the first one that arrives upgrades a private scope to the shared one, which is
   * what lets two different queries over one entity meet on the same row.
   */
  snapshot(registration: Registration, entity: string | null, rows: readonly Row[]): void {
    const scope = entity ?? registration.scope;
    this.#reseat(
      registration,
      scope,
      rows.map((row) => row.id),
      (held) => {
        for (const row of rows) {
          if (held.has(row.id)) this.#identity.merge(scope, row.id, row);
        }
      },
    );
  }

  /** A patch list: values merged into the map, membership and order folded over the ids. */
  patch(registration: Registration, patches: readonly RowPatch[]): void {
    const scope = registration.scope;
    // A `delete` is this window losing the row, never the map losing it: another window holding
    // the same row keeps it until its own delete arrives.
    this.#reseat(registration, scope, orderAfterPatches(registration.ids, patches), (held) => {
      for (const patch of patches) {
        if (patch.op === 'delete' || patch.row === null) continue;
        if (held.has(patch.id)) this.#identity.merge(scope, patch.id, patch.row);
      }
    });
  }

  /** The window's rows, in its order. Absent ids are skipped — a released row renders as gone. */
  rows(registration: Registration): readonly Row[] {
    const out: Row[] = [];
    for (const id of registration.ids) {
      const row = this.#identity.peek(registration.scope, id);
      if (row !== undefined) out.push(row);
    }
    return out;
  }

  /**
   * Move the window to `nextIds` under `scope`, writing values in between. One batch per frame,
   * and one emit for the window that caused it.
   *
   * The retain comes before the write and the release after it, so a row this window keeps across
   * the move never reaches zero holds and gets dropped out from under the value it is about to be
   * given. `write` only touches ids the window ends up holding — a value nobody holds is a value
   * no release will ever reclaim.
   */
  #reseat(
    registration: Registration,
    scope: RowScope,
    nextIds: readonly string[],
    write: (held: ReadonlySet<string>) => void,
  ): void {
    const previous = this.#writing;
    this.#writing = registration;
    try {
      this.#identity.batch(() => {
        for (const id of nextIds) this.#identity.retain(scope, id);
        write(new Set(nextIds));
        for (const id of registration.ids) this.#identity.release(registration.scope, id);
        registration.scope = scope;
        registration.ids = nextIds;
      });
    } finally {
      this.#writing = previous;
    }
    this.#emit(registration);
  }

  #emit(registration: Registration): void {
    registration.setRows(this.rows(registration));
  }
}

function holds(registration: Registration, changed: ReadonlySet<RowKey>): boolean {
  for (const id of registration.ids) {
    if (changed.has(rowKey(registration.scope, id))) return true;
  }
  return false;
}
