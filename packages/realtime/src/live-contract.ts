// What a live query IS: the contract a definition satisfies and the subscription one socket holds.
// Split from `live-query.ts` because four modules need the shape and none of them needs the
// registry that runs it — and because one file runs one job.
//
// The id is NOT here, and no longer anywhere in this package: a `qid` is `@ultimat3/query`'s
// `queryHash(name, input)`, imported across the declared `realtime -> query` edge. `qidOf` was the
// same two lines over this package's own copy of the canonical form, and the two had already
// diverged on an `undefined`-valued key — while `planResume` compares a cursor's `queryHash` and
// `liveQueryDefinition` keys the shared window by the qid, so a divergence is every resume
// decision and every window lookup keyed differently.

import type { Actor } from '@ultimat3/core';
import type { LiveCursor } from './cursor';
import type { JsonValue, Row } from './json';
import type { IncrementalMatcher } from './matcher-bridge';
import type { SyncSocket } from './socket';

export interface SnapshotResult<R extends Row = Row> {
  readonly rows: readonly R[];
  readonly lsn: string;
}

export interface LiveQueryDefinition<R extends Row = Row> {
  readonly name: string;
  /** Dependency set for the pre-filter. `x verify` rejects a `live: true` query without one. */
  readonly entities: readonly string[];
  /** Read set. Lets the pre-filter skip updates that touch no column this query reads. */
  readonly columns?: readonly string[];
  /** Bounded read (`orderBy` + `limit`, enforced by `x verify`), unfiltered by policy. */
  snapshot(args: { input: JsonValue }): Promise<SnapshotResult<R>>;
  /** Subscribe-time gate. Throws to deny — the same `policy` used by HTTP, jobs, and MCP. */
  authorize?(args: { actor: Actor | null; input: JsonValue }): void | Promise<void>;
  /** Row-level gate, evaluated per subscriber. The only row filter in the pipeline. */
  visible(args: { actor: Actor | null; row: R; input: JsonValue }): boolean | Promise<boolean>;
  /** Built once per `qid`, since a qid pins both the query and its input. */
  matcher(input: JsonValue): IncrementalMatcher;
  /**
   * The entity every row of this result set belongs to, resolved per input exactly as `matcher`
   * is. It is the client's identity scope, and it can only come from here: a browser cannot
   * compile the shape a `sql` produces. `null` means "not stated", and the client then keeps the
   * rows private to that one subscription rather than guessing.
   */
  rowEntity?(input: JsonValue): string | null;
  /**
   * Resolve whatever this input needs before an entry is built. `matcher` is synchronous by
   * design — a change event must not await anything — so a definition that has to compile a
   * source or a shape does it here, after `authorize` allowed this subscriber and before the
   * shared window exists.
   */
  prepare?(input: JsonValue): Promise<void>;
}

export interface LiveSubscription {
  readonly sid: string;
  readonly qid: string;
  readonly socket: SyncSocket;
  readonly input: JsonValue;
  readonly definition: LiveQueryDefinition;
  cursor: LiveCursor;
}
