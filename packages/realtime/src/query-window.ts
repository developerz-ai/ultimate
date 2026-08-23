// The shared, pre-policy result window one query id is served from: how it is built, how it is
// read once for N subscribers, and how one that is known to be wrong is replaced. The authz
// decision is never here — `live-query.ts` owns that, once per subscriber, over what this returns.

import { WindowReadTimeoutError } from './errors';
import type { JsonValue, Row } from './json';
import type { LiveQueryDefinition, LiveSubscription, SnapshotResult } from './live-contract';
import type { IncrementalMatcher, SubscriptionShape } from './matcher-bridge';
import type { Scheduler } from './thundering-herd';
import { timeoutScheduler } from './thundering-herd';
import { WindowLock } from './window-lock';

/**
 * How long the SHARED read may hold the slot before it is released. On by default and with no
 * "off" spelling: a shared read with no deadline is exactly the defect this closes — one
 * `definition.snapshot` that never settles pinned `entry.reading` for the life of the process and
 * every later cold subscriber joined a promise nothing would resolve. A caller that wants a longer
 * one names a bigger number.
 */
export const DEFAULT_READ_DEADLINE_MS = 30_000;

export interface EntryOptions {
  /** Non-finite or non-positive falls back to the default — `0` cannot mean both "now" and "never". */
  readonly readDeadlineMs?: number | undefined;
  /** Injected so a deadline is provable without waiting for one. */
  readonly schedule?: Scheduler | undefined;
}

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
  reading: PendingRead | null;
  /**
   * Reads issued against this entry, ever. It is the ORDER of two reads, which nothing else here
   * can answer: a definition with no lsn provider returns `''` from every snapshot.
   */
  generation: number;
  /** The generation of the newest read whose rows are in `rows`. `0` before the first one lands. */
  applied: number;
  readonly readDeadlineMs: number;
  readonly schedule: Scheduler;
}

/**
 * One read and which read it is. They are one fact — a joiner needs the promise AND the generation
 * it will have to compare against when it lands — and two fields on the entry is two writes a later
 * edit can separate.
 */
export interface PendingRead {
  readonly generation: number;
  readonly result: Promise<SnapshotResult>;
}

export function createEntry(
  qid: string,
  definition: LiveQueryDefinition,
  input: JsonValue,
  matcher: IncrementalMatcher,
  options?: EntryOptions,
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
    generation: 0,
    applied: 0,
    readDeadlineMs: usableDeadline(options?.readDeadlineMs),
    schedule: options?.schedule ?? timeoutScheduler,
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
  const pending = forced || entry.reading === null ? startRead(entry) : entry.reading;
  const result = await pending.result;
  return await entry.lock.run(async () => {
    // Two rules, and neither can stand in for the other. Against another READ it is identity —
    // the same check `startRead` makes on `entry.reading` one function down, and the one
    // `packages/cache/src/single-flight.ts` makes for the same reason — because an lsn cannot
    // order two reads at all: a definition with no lsn provider answers `''` for both, and
    // `'' >= ''` let the older one overwrite the gap repair the newer one had just landed, with
    // `stale` already cleared by its issue and therefore nothing left to re-read. Against a
    // CHANGE it is still the lsn, because a fanout moved `entry.lsn` forwards while this read was
    // in flight and rewinding to what the read saw hands that subscriber rows the fanout has
    // moved past — except for a forced read, which was issued *because* what is under it is
    // wrong.
    if (isNewestRead(entry, pending) && (forced || result.lsn >= entry.lsn)) {
      applyRead(entry, pending, result);
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
  const pending = startRead(entry);
  const result = await pending.result;
  // Same identity rule as `fillWindow`: a read issued before this one may still be in flight, and
  // whichever was issued LAST is the one the window keeps.
  if (isNewestRead(entry, pending)) applyRead(entry, pending, result);
}

/** Is this the newest read to have landed? An older one's rows are behind the window, not on it. */
function isNewestRead(entry: QueryEntry, pending: PendingRead): boolean {
  return pending.generation > entry.applied;
}

function applyRead(entry: QueryEntry, pending: PendingRead, result: SnapshotResult): void {
  entry.applied = pending.generation;
  entry.rows = result.rows;
  if (result.lsn > entry.lsn) entry.lsn = result.lsn;
}

function usableDeadline(declared: number | undefined): number {
  if (declared === undefined) return DEFAULT_READ_DEADLINE_MS;
  return Number.isFinite(declared) && declared > 0 ? declared : DEFAULT_READ_DEADLINE_MS;
}

/**
 * Publishes the in-flight read, and clears it as it settles — the share is per read, not a cache.
 *
 * The deadline frees the SLOT. It cannot cancel the read — nothing here can, and pretending
 * otherwise would be a second, false promise — so the abandoned read runs to completion with
 * nobody listening, and the next caller issues its own instead of joining a corpse.
 */
function startRead(entry: QueryEntry): PendingRead {
  // Cleared here rather than when the read lands: the read about to be issued is the one that
  // answers the staleness, so a second caller must join it instead of forcing another.
  entry.stale = false;
  entry.generation += 1;

  const read = readSnapshot(entry);
  let expire: () => void = noop;
  const deadline = new Promise<never>((_resolve, reject) => {
    // Assigned synchronously — a Promise executor runs before the constructor returns — so `done`
    // can never fire against the placeholder and leave a timer armed.
    expire = entry.schedule(() => {
      // The same restoration `readSnapshot`'s catch makes, and for the same reason: a read that
      // did not answer must not leave the window looking authoritative. Unconditional even when a
      // NEWER read already holds the slot, which can only cost one extra read — over-reading is
      // safe here and under-reading is the divergence `stale` exists to prevent.
      entry.stale = true;
      reject(new WindowReadTimeoutError({ qid: entry.qid, afterMs: entry.readDeadlineMs }));
    }, entry.readDeadlineMs);
  });

  const reading: PendingRead = {
    generation: entry.generation,
    // A race, not just an eviction: freeing the slot alone would leave every caller ALREADY joined
    // awaiting a promise nothing settles. `Promise.race` subscribes to both, so a read that
    // rejects AFTER losing the race is still handled and never surfaces as an unhandled rejection.
    result: Promise.race([read, deadline]),
  };
  entry.reading = reading;

  const done = (): void => {
    // An armed timer per completed read keeps the process alive and is a leak in its own right.
    expire();
    // Identity, never presence — the rule the deadline makes load-bearing rather than merely
    // careful: a read that answers after its deadline released the slot must not clear whatever
    // holds it now, or that newer read's joiners share a promise the entry no longer answers for.
    if (entry.reading === reading) entry.reading = null;
  };
  void reading.result.then(done, done);
  return reading;
}

/**
 * The definition's read, with the staleness put back when it does not answer.
 *
 * Clearing the mark on the way in and never restoring it was the gap repair happening once and
 * never again: the snapshot that was going to replace an invalidated window rejects — the pool is
 * exhausted by the same incident that caused the gap — and the entry is left unmarked over rows it
 * is known to have missed a change on. Nothing re-reads, `#resnapshot` serves every desynced
 * subscriber out of that divergent window and clears their marks, and the divergence `stale` exists
 * to prevent is now permanent and silent. `async` so a definition that throws synchronously takes
 * the same path as one that rejects.
 */
async function readSnapshot(entry: QueryEntry): Promise<SnapshotResult> {
  try {
    return await entry.definition.snapshot({ input: entry.input });
  } catch (error) {
    entry.stale = true;
    throw error;
  }
}

export function orgIdOf(input: JsonValue): string | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null;
  const value = input['orgId'];
  return typeof value === 'string' ? value : null;
}

const noop = (): void => undefined;
