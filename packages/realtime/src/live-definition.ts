// The one bridge from a declared `query({ live: true })` to something `LiveQueryRegistry` can
// register. It exists so the per-subscriber rule holds for real declarations and not only for the
// definitions a test writes by hand: without it `policy-gate.ts` — this package's single authz
// seam — has no caller at all, and a live `subscribe` frame answers "no live query registered".
//
// The split it enforces is the whole point. Everything keyed by query id is subject-less: the
// source, the shape, the matcher, the row window. Everything that decides about an actor —
// `authorize` at subscribe, `visible` per row per delivery — is keyed by subscriber and evaluated
// every time. Collapsing the second onto the first is privilege escalation with a cache hit rate.

import type { Ctx } from '@ultimat3/core';
import { finiteOption } from '@ultimat3/core';
import { type AnyQuery, queryHash, queryName } from '@ultimat3/query';
import { LiveRowUnidentifiedError } from './errors';
import { isRow, type JsonValue, type Row } from './json';
import type { LiveQueryDefinition, SnapshotResult } from './live-contract';
import { type IncrementalMatcher, matcherFor, type Projection } from './matcher-bridge';
import { authorizeWithPolicy, visibleWithPolicy } from './policy-gate';

export interface LiveDefinitionOptions {
  /**
   * The node's own context — never a subscriber's. It supplies services, clock and locale to the
   * shared read; it supplies no authority, because that read is built with the query's policy
   * switched off and every row leaving it is gated per subscriber.
   */
  readonly ctx: Ctx;
  /**
   * Where the shared window sits in the change stream, asked at snapshot time. Without a feed
   * position a reconnect can only re-snapshot, so a node with a replicator should pass its lsn.
   */
  readonly lsn?: () => string;
  /** Pins the reconnect epoch in tests; the server derives it from the build. */
  readonly epoch?: string;
  /**
   * How many distinct inputs keep a compiled source. The map is keyed by an argument the client
   * chooses, so it is bounded: an eviction costs one rebuild, and a live entry holds its own
   * matcher, so nothing in flight notices.
   */
  readonly maxWindows?: number;
}

/**
 * A resolved `(query, input)` pair: everything the matcher and the window need, and nothing that
 * knows who is subscribing. One per query id, shared by every subscriber of it.
 */
interface SharedWindow {
  readonly matcher: IncrementalMatcher;
  /** The compiled shape's root entity — the client's identity scope for every row of this read. */
  readonly rowEntity: string;
  read(): Promise<readonly Row[]>;
}

/**
 * The columns this query's result set carries, learned from the rows it returns rather than
 * declared — a projection lives inside the `sql` provider's closure and there is nothing static to
 * read it from. Learned once and kept, because the case the window's own rows cannot answer is an
 * EMPTY window: the first row to arrive would otherwise be sent as the whole table row.
 */
const learnProjection = (): { read: () => Projection; teach: (rows: readonly Row[]) => void } => {
  let projection: Projection;
  return {
    read: () => projection,
    // Never unlearned: a window that empties still describes the same result set, and forgetting
    // would put the leak back on the first row to return.
    teach: (rows) => {
      if (projection === undefined && rows[0] !== undefined)
        projection = new Set(Object.keys(rows[0]));
    },
  };
};

/**
 * A matcher for an input nothing has resolved yet. It refuses to decide rather than reporting "no
 * change": a subscriber told nothing happened diverges silently, and `refill` is the one answer
 * the registry already knows how to handle — mark desynced, re-snapshot.
 */
const UNRESOLVED: IncrementalMatcher = {
  entities: [],
  match: () => ({ patches: [], refill: true }),
};

/**
 * Registrable definition for one declared query. `register` takes it by name, so what comes back
 * is input-independent: the per-input half is resolved by `prepare`, which the registry awaits
 * before it builds an entry — and only after that subscriber's own `authorize` allowed it.
 */
export function liveQueryDefinition(
  target: AnyQuery,
  options: LiveDefinitionOptions,
): LiveQueryDefinition {
  const name = queryName(target);
  // Keyed by query id, and holding no subscriber's decision — that is what makes it shareable.
  const windows = new Map<string, SharedWindow>();

  const resolve = async (input: JsonValue): Promise<SharedWindow> => {
    const qid = queryHash(name, input);
    const seated = windows.get(qid);
    if (seated !== undefined) return seated;
    const live = await target.live(input, {
      ctx: options.ctx,
      // No subject: see `ToLiveOptions.enforce`. `authorize` below is the subscribe-time
      // decision, and it runs once per subscriber rather than once per query id.
      enforce: false,
      ...(options.epoch === undefined ? {} : { epoch: options.epoch }),
    });
    // One build, and the window reads through it. `live.execute()` runs the source the shape and
    // the dependency set above were taken from, so the rows a subscriber is served and the matcher
    // that patches them describe the same `(query, input)` by construction. Asking `sourceFor` for
    // a second subject-less copy — which is what this did — paid for the parse and the `sql()`
    // twice per query id and left two descriptions of one read that agreed only by luck.
    const projection = learnProjection();
    const built: SharedWindow = {
      matcher: matcherFor(live, projection.read),
      // `assertMatchable` already refused a shape without one, so this is the entity the matcher
      // patches rows of — the same name `ChangeEvent.entity` and `tx.<table>` use.
      rowEntity: live.shape.entity,
      read: async () => {
        const rows = rowsOf(name, await live.execute());
        projection.teach(rows);
        return rows;
      },
    };
    windows.set(qid, built);
    evictOldest(windows, finiteOption('live()', 'maxWindows', options.maxWindows ?? 256));
    return built;
  };

  return {
    name,
    // The dependency set is only known once an input has produced a shape, so the registry reads
    // it off the resolved matcher. This is the value for a definition asked before `prepare` ran,
    // and it matches nothing rather than guessing an entity.
    entities: [],
    prepare: async (input) => {
      await resolve(input);
    },
    snapshot: async ({ input }): Promise<SnapshotResult> => {
      const window = await resolve(input);
      return { rows: await window.read(), lsn: options.lsn?.() ?? '' };
    },
    matcher: (input) => windows.get(queryHash(name, input))?.matcher ?? UNRESOLVED,
    // Read off the same resolved window as the matcher, so the scope the client keys rows under and
    // the entity the matcher patches them from can never be two different names.
    rowEntity: (input) => windows.get(queryHash(name, input))?.rowEntity ?? null,
    // The two per-subscriber gates, both through the package's one authz seam. Neither result is
    // memoised anywhere: `authorize` runs on every subscribe, `visible` on every row of every
    // delivery, and there is no key here an actor could share with another actor.
    authorize: authorizeWithPolicy(target.policy, { query: name, ctx: options.ctx }),
    visible: visibleWithPolicy(target.policy, { query: name, ctx: options.ctx }),
  };
}

/** Insertion-ordered, so the oldest compiled input is the one that goes. */
function evictOldest(windows: Map<string, SharedWindow>, max: number): void {
  while (windows.size > max) {
    const oldest = windows.keys().next();
    if (oldest.done === true) return;
    windows.delete(oldest.value);
  }
}

/**
 * Rows crossing the wire are addressed by `id` — patches, cursors and the local store all key on
 * it. A projection without one is refused here rather than delivered as a row nobody can patch:
 * the alternative is a subscription that appears to work until the first update.
 */
function rowsOf(query: string, rows: readonly object[]): readonly Row[] {
  const out: Row[] = [];
  for (const row of rows) {
    if (!isRow(row)) throw new LiveRowUnidentifiedError({ query, keys: Object.keys(row) });
    out.push(row);
  }
  return out;
}
