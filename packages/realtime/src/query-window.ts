// The shared, pre-policy result window one query id is served from: how it is built, how it is
// read once for N subscribers, and how one that is known to be wrong is replaced. The authz
// decision is never here — `live-query.ts` owns that, once per subscriber, over what this returns.

import type { JsonValue, Row } from './json';
import type { LiveQueryDefinition, LiveSubscription, SnapshotResult } from './live-contract';
import type { IncrementalMatcher, SubscriptionShape } from './matcher-bridge';
import { WindowLock } from './window-lock';

export interface QueryEntry {
  readonly qid: string;
  readonly definition: LiveQueryDefinition;
  readonly input: JsonValue;
  /** Told to the client on every snapshot: the identity scope its rows belong under. */
  readonly rowEntity: string | null;
  readonly shape: SubscriptionShape;
  readonly matcher: IncrementalMatcher;
  readonly subscribers: Map<string, LiveSubscription>;
  /**
   * The shared, *pre-policy* result window. One per query id, bounded by the query's `limit`, and
   * the reason the matcher can run once for N subscribers: the read is shared, the authz is not.
   */
  rows: readonly Row[];
  lsn: string;
  /**
   * This window is known to have missed at least one change, so patching it would compound the
   * error. Set when the change stream skipped a sequence and when a matcher reports it lost the
   * window's tail; cleared by the read that replaces the rows. It is *not* a subscriber's desync —
   * that is per socket, and this is the window every one of them shares.
   */
  stale: boolean;
  /** Serial lane over `rows`/`lsn`. Every fanout and every window assignment takes its turn here. */
  readonly lock: WindowLock;
  /** The read in flight, shared by every subscriber that arrives during it. `null` between reads. */
  reading: Promise<SnapshotResult> | null;
}

export function createEntry(
  qid: string,
  definition: LiveQueryDefinition,
  input: JsonValue,
  matcher: IncrementalMatcher,
): QueryEntry {
  return {
    qid,
    definition,
    input,
    // Resolved with the matcher, from the same build: `prepare` has already run, so a definition
    // that compiles its shape per input can answer.
    rowEntity: definition.rowEntity?.(input) ?? null,
    shape: {
      qid,
      // The matcher knows the dependency set this *input* produced; `definition.entities` is the
      // static declaration and can only be a superset of it. Preferring the matcher is what lets a
      // definition built from a real query carry no static list at all.
      entities: matcher.entities.length > 0 ? matcher.entities : definition.entities,
      orgId: orgIdOf(input),
      ...(definition.columns ? { columns: definition.columns } : {}),
    },
    matcher,
    subscribers: new Map(),
    rows: [],
    lsn: '',
    stale: false,
    lock: new WindowLock(),
    reading: null,
  };
}

/**
 * The window this subscriber is served from, read once per entry. A subscriber arriving while
 * another's read is in flight joins that read rather than issuing its own — N cold subscribers on
 * one query id being N reads is the shared window not existing.
 *
 * The result lands in the lane, and never backwards. A snapshot that resolved after a newer change
 * had already been fanned out would rewind every later subscriber to rows the window has moved
 * past, so a stale read is discarded and its caller is served from the newer window instead.
 */
export async function fillWindow(
  entry: QueryEntry,
): Promise<{ rows: readonly Row[]; lsn: string }> {
  // Read before `startRead` clears it: a second caller arriving during the read joins it and is
  // not the one that forced it, which is what keeps one forced read from becoming N.
  const forced = entry.stale;
  const result = await (forced || entry.reading === null ? startRead(entry) : entry.reading);
  return await entry.lock.run(async () => {
    if (forced) {
      // A forced read replaces the window whatever its lsn says: it was issued *because* what is
      // under it is wrong, and a definition with no lsn provider answers `''` — which the
      // never-backwards rule below would read as older than what we hold and discard, leaving
      // every subscriber served from the window the gap already invalidated.
      entry.rows = result.rows;
      if (result.lsn > entry.lsn) entry.lsn = result.lsn;
    } else if (result.lsn >= entry.lsn) {
      entry.rows = result.rows;
      entry.lsn = result.lsn;
    }
    return { rows: entry.rows, lsn: entry.lsn };
  });
}

/**
 * The same replacement, for a caller that is already holding the lane. A fanout cannot call
 * `fillWindow` — that takes the entry's own lane, and a lane is not reentrant — so the one path
 * that repairs a stale window mid-fanout is spelled here rather than deadlocking on the other.
 */
export async function refillWindowInLane(entry: QueryEntry): Promise<void> {
  const result = await startRead(entry);
  entry.rows = result.rows;
  if (result.lsn > entry.lsn) entry.lsn = result.lsn;
}

/** Publishes the in-flight read, and clears it as it settles — the share is per read, not a cache. */
function startRead(entry: QueryEntry): Promise<SnapshotResult> {
  // Cleared here rather than when the read lands: the read about to be issued is the one that
  // answers the staleness, so a second caller must join it instead of forcing another.
  entry.stale = false;
  const reading = entry.definition.snapshot({ input: entry.input });
  entry.reading = reading;
  const done = (): void => {
    if (entry.reading === reading) entry.reading = null;
  };
  void reading.then(done, done);
  return reading;
}

export function orgIdOf(input: JsonValue): string | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null;
  const value = input['orgId'];
  return typeof value === 'string' ? value : null;
}
