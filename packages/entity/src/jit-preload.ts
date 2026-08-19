// Single responsibility: the sibling-aware preload. A point lookup whose id is a foreign key on a
// page already read resolves that key for EVERY row of the page in one statement, and the rest of
// the loop is served from memory. A sequential `for … of` loop awaits between iterations, so its
// lookups never share a microtask and the coalescer cannot see them; this is what batches them.
//
// The trigger carries an id, not a row, so what a page leaves behind is an index of its foreign
// key VALUES rather than a map keyed by row identity: an id is a thing that can be looked up in
// it, and a page therefore costs its keys rather than its rows. That was true PER PAGE and false
// across them until `MAX_SIBLING_KEYS` — the store outlives every page and dies with the ctx,
// which for a job is the whole attempt, so both maps here are bounded and evict the oldest page.
//
// The scope guard is a security boundary, not a tuning knob. A preloaded row is served only to a
// lookup with the same scope key, the same client and no write since — anything else reads the
// statement it always read.

import type { Ctx } from '@ultimat3/core';
import { tryUseContext } from '@ultimat3/core';
import type { DbClient } from '@ultimat3/db';
import {
  type Answer,
  keyOf,
  MAX_IDS_PER_STATEMENT,
  type PointRead,
  readByIds,
  statementChunks,
} from './batch-read';
import { columnFor } from './column';
import type { EntityCore } from './entity';

/** The rows one page's worth of foreign keys resolved to, under one scope. */
interface Bucket {
  /** The entity the rows belong to — what a write invalidates. */
  readonly entity: string;
  /** Where the rows were read from. A pinned client and the ambient pool are two places. */
  readonly client: DbClient;
  /** Writes to `entity` when the bucket was opened. A later write makes every row of it stale. */
  readonly generation: number;
  /** Never rejects: a failure is an `Answer`, so an id nobody asks for cannot go unhandled. */
  readonly rows: Map<string, Promise<Answer>>;
}

interface Store {
  /** `[targetEntity, targetProperty]` -> id key -> every id the page carried for that key. */
  readonly siblings: Map<string, Map<string, readonly unknown[]>>;
  /** Scope key -> the rows preloaded under it. */
  readonly preloaded: Map<string, Bucket>;
  /** Entity name -> writes this request has issued against it. */
  readonly writes: Map<string, number>;
}

/**
 * Per request, keyed by ctx identity, so a page's siblings and everything preloaded from them die
 * with the request that read them — the shape the microtask coalescer's store has, one file over.
 */
const requests = new WeakMap<object, Store>();

const storeFor = (ctx: Ctx): Store => {
  const key: object = ctx;
  const existing = requests.get(key);
  if (existing !== undefined) return existing;
  const created: Store = { siblings: new Map(), preloaded: new Map(), writes: new Map() };
  requests.set(key, created);
  return created;
};

/**
 * How many id keys ONE edge may hold, and how many rows one bucket may keep — a few pages' worth,
 * the way `MAX_IDS_PER_STATEMENT` bounds a statement.
 *
 * `MAX_IDS_PER_STATEMENT` bounded the statement and nothing bounded the STORE: every page merged
 * its keys in and the store died only with the ctx, which for a job is the whole attempt. Measured
 * at 1,000 pages x 1,000 rows with distinct foreign keys, rows dropped after each call and
 * `Bun.gc(true)` either side: **159.3 MB retained**, against 2.7 MB with the tagging off — so a
 * 12M-row `backfill()` retains ~2 GB and OOMs the worker on the DEFAULT configuration, since
 * `jitPreload` defaults to true and `backfill()` names no driver option.
 *
 * Four statements' worth. The keys of one page are filed contiguously, so the survivors are the
 * newest pages' and the arrays every evicted key referenced go with them — which is what makes the
 * bound a bound on bytes and not only on entries. Past it a lookup DECLINES, and declining is the
 * old behaviour everywhere else in this file: the caller reads the statement it always read.
 */
export const MAX_SIBLING_KEYS = MAX_IDS_PER_STATEMENT * 4;

/**
 * Newest wins, oldest goes. A `Map` iterates in insertion order, so its first key is the oldest
 * page's — and the page a sequential `for … of` loop is walking is the newest one, which is the
 * only page this store exists to answer for. Re-filed rather than overwritten, so a key a later
 * page carries again moves to the newest end instead of ageing out under it.
 */
const remember = <V>(index: Map<string, V>, key: string, value: V, cap: number): void => {
  index.delete(key);
  index.set(key, value);
  while (index.size > cap) {
    const oldest = index.keys().next();
    if (oldest.done === true) return;
    index.delete(oldest.value);
  }
};

/** Both ends of the edge: a key pointing at another column of the same entity is another edge. */
const siblingKey = (targetEntity: string, targetProperty: string): string =>
  JSON.stringify([targetEntity, targetProperty]);

/** TEST SEAM: id keys this request is holding, across every edge. A bound nothing can observe is a
 * bound nothing can pin, and `MAX_SIBLING_KEYS` is the number this answers against. */
export const siblingKeysHeld = (ctx: Ctx): number => {
  const store = requests.get(ctx);
  if (store === undefined) return 0;
  let held = 0;
  for (const index of store.siblings.values()) held += index.size;
  return held;
};

const writesTo = (store: Store, entity: string): number => store.writes.get(entity) ?? 0;

/**
 * What a page of rows leaves behind: for each foreign key it declares, the distinct values that
 * page carried, filed under every one of them. A later `findById` for any of those values is a
 * lookup this page can answer for all of them.
 *
 * Values only. Rows are not held, so a page read early in a long request costs its keys and not
 * its rows, and a group of one still counts — a hundred posts by one author is one statement for
 * the whole loop rather than a hundred.
 */
export const tagSiblings = <Row>(entity: EntityCore<Row>, rows: readonly Row[]): void => {
  if (rows.length === 0) return;
  const ctx = tryUseContext();
  // No request, no store: a job or a script reads the statement it always read. Asked first —
  // resolving the foreign keys is a pass over the columns, and nothing would read the answer.
  if (ctx === undefined) return;
  const references = entity.$references();
  if (references.length === 0) return;
  const store = storeFor(ctx);
  for (const reference of references) {
    // The declaring column's own kind: a foreign key mirrors the key it points at, and a value is
    // filed here exactly as `findById` will spell it when it comes looking.
    const kind = columnFor(entity.$columns, reference.property)?.$meta.kind;
    if (kind === undefined) continue;
    const ids: unknown[] = [];
    const keys = new Set<string>();
    for (const row of rows) {
      const value = (row as Record<string, unknown>)[reference.property];
      // A nullable key that resolved to nothing is data, not a row to go looking for.
      if (value === null || value === undefined) continue;
      const key = keyOf(kind, value);
      if (keys.has(key)) continue;
      keys.add(key);
      ids.push(value);
    }
    if (ids.length === 0) continue;
    const at = siblingKey(reference.targetEntity, reference.targetProperty);
    const index = store.siblings.get(at) ?? new Map<string, readonly unknown[]>();
    for (const key of keys) remember(index, key, ids, MAX_SIBLING_KEYS);
    store.siblings.set(at, index);
  }
};

/**
 * A write makes every preloaded row of that entity stale, so the bucket holding them is not read
 * again. Called before the statement goes out: a row read back afterwards is the row the write
 * left, and one read concurrently with it was concurrent either way.
 */
export const forgetPreloaded = (entityName: string): void => {
  const ctx = tryUseContext();
  if (ctx === undefined) return;
  const store = requests.get(ctx);
  if (store === undefined) return;
  store.writes.set(entityName, writesTo(store, entityName) + 1);
};

/** The bucket this lookup may be served from, or `undefined` — a stale one is dropped, not read. */
const usableBucket = <Row>(
  store: Store,
  read: PointRead<Row>,
  scope: string,
): Bucket | undefined => {
  const open = store.preloaded.get(scope);
  if (open === undefined) return undefined;
  if (open.client === read.client && open.generation === writesTo(store, open.entity)) return open;
  store.preloaded.delete(scope);
  return undefined;
};

type Settlers = ReadonlyMap<string, (answer: Answer) => void>;

/** One statement at a time: a page wide enough to split must not take the pool with it. */
const fill = async <Row>(
  read: PointRead<Row>,
  ids: readonly unknown[],
  settlers: Settlers,
): Promise<void> => {
  for (const chunk of statementChunks(ids)) {
    let answers: ReadonlyMap<string, Answer>;
    try {
      answers = await readByIds(read, chunk);
    } catch (error) {
      // The statement failed, so it fails for everyone it was widened to cover — which is what
      // the single statement each of them would have sent would have done.
      for (const id of chunk) settlers.get(keyOf(read.key.kind, id))?.({ error });
      continue;
    }
    for (const id of chunk) {
      const at = keyOf(read.key.kind, id);
      // An id the statement did not answer for is a row that is not there — `findById`'s null.
      settlers.get(at)?.(answers.get(at) ?? { row: null });
    }
  }
};

/**
 * The statement, and one promise per id it will answer for. Only the ids the bucket does not
 * already hold are read: a second lookup into a page it already resolved is memory, not a wire.
 */
const preload = <Row>(read: PointRead<Row>, bucket: Bucket, ids: readonly unknown[]): void => {
  const settlers = new Map<string, (answer: Answer) => void>();
  const wanted: unknown[] = [];
  for (const id of ids) {
    const at = keyOf(read.key.kind, id);
    if (bucket.rows.has(at)) continue;
    // The executor runs synchronously, so `settle` is assigned before the promise is stored.
    let settle!: (answer: Answer) => void;
    const answer = new Promise<Answer>((resolve) => {
      settle = resolve;
    });
    // Bounded for the reason the sibling index is: a bucket holds ROWS, so a long request that
    // preloads page after page retains every row it ever resolved. An evicted entry still settles
    // — `fill` holds its own settler — and a lookup that no longer finds one reads its own
    // statement, which is what it would have read had no page indexed the id at all.
    remember(bucket.rows, at, answer, MAX_SIBLING_KEYS);
    settlers.set(at, settle);
    wanted.push(id);
  }
  // Nothing awaits this: an id nobody asks for still settles, and it settles with an `Answer`
  // rather than a rejection, so a failed statement cannot go unhandled.
  void fill(read, wanted, settlers);
};

const answered = <Row>(answer: Promise<Answer>): Promise<Row | null> =>
  answer.then((settled) =>
    'error' in settled ? Promise.reject(settled.error) : (settled.row as Row | null),
  );

/**
 * The row this lookup is served from a page already read, or `undefined` when no page can answer
 * it: nothing read in this request, an id that is no page's foreign key, a write since, or
 * another client. Declining is always correct — the caller reads the statement it always read.
 */
export const preloadedFindById = <Row>(
  ctx: Ctx,
  read: PointRead<Row>,
  scope: string,
  id: unknown,
): Promise<Row | null> | undefined => {
  const store = requests.get(ctx);
  if (store === undefined) return undefined;
  const filedAt = keyOf(read.key.kind, id);
  const bucket = usableBucket(store, read, scope);
  const already = bucket?.rows.get(filedAt);
  if (already !== undefined) return answered<Row>(already);
  const ids = store.siblings.get(siblingKey(read.entity.$name, read.key.property))?.get(filedAt);
  if (ids === undefined) return undefined;
  const target = bucket ?? {
    entity: read.entity.$name,
    client: read.client,
    generation: writesTo(store, read.entity.$name),
    rows: new Map<string, Promise<Answer>>(),
  };
  store.preloaded.set(scope, target);
  preload(read, target, ids);
  const answer = target.rows.get(filedAt);
  return answer === undefined ? undefined : answered<Row>(answer);
};
