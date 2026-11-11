// Single responsibility: put one row's history rows in the order the writes happened. Each version
// is an edge from its `before` image to its `after`, and the order is the walk that uses every edge
// once (an Eulerian path: delete-then-reinsert and A→B→A hold) — across every row, because `at` is
// a transaction's START and not its write order. `at` breaks ties, and orders what no walk covers.

import type { HistoryColumns } from './history';
import type { RowOf } from './types';

/** One stored history row, as the history table reads it. */
export type HistoryRecord = RowOf<HistoryColumns>;

/**
 * One version of a row: the stored history row and its 1-based place in the row's history. The
 * number is a position in what is RETAINED — after a `retain` sweep, version 1 is the oldest kept.
 */
export type HistoryVersion = HistoryRecord & { readonly version: number };

/** An image as a node: its columns in key order, the ones whose change records nothing left out. */
const nodeOf = (image: unknown, ignored: ReadonlySet<string>): string => {
  if (typeof image !== 'object' || image === null) return 'null';
  const entries = Object.entries(image as Record<string, unknown>)
    .filter(([key]) => !ignored.has(key))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify(entries);
};

/** Where no walk decides (a purged prefix, a hand-written row): insert, update, delete, then id. */
// A Map, never an object literal: a hand-written `op` of `constructor` read a function off one.
const OP_RANK: ReadonlyMap<string, number> = new Map([
  ['insert', 0],
  ['update', 1],
  ['delete', 2],
]);
const byRank = (a: HistoryRecord, b: HistoryRecord): number =>
  (OP_RANK.get(a.op) ?? 1) - (OP_RANK.get(b.op) ?? 1) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Hierholzer over one instant's rows from `start`; `null` when no walk uses every row once. */
function walk(
  group: readonly HistoryRecord[],
  start: string,
  ignored: ReadonlySet<string>,
): HistoryRecord[] | null {
  const out = new Map<string, HistoryRecord[]>();
  for (const row of group) {
    const from = nodeOf(row.before, ignored);
    out.set(from, [...(out.get(from) ?? []), row]);
  }
  const stack: { node: string; row: HistoryRecord | null }[] = [{ node: start, row: null }];
  const path: HistoryRecord[] = [];
  while (stack.length > 0) {
    const top = stack[stack.length - 1];
    if (top === undefined) break;
    const next = out.get(top.node)?.shift();
    if (next !== undefined) stack.push({ node: nodeOf(next.after, ignored), row: next });
    else {
      stack.pop();
      if (top.row !== null) path.push(top.row);
    }
  }
  path.reverse();
  if (path.length !== group.length) return null;
  let at = start;
  for (const row of path) {
    if (nodeOf(row.before, ignored) !== at) return null;
    at = nodeOf(row.after, ignored);
  }
  return path;
}

/**
 * Where the one walk over EVERY row starts: the image that is produced one time fewer than it is
 * consumed (the first insert's `null`, or the oldest retained `before`), or — when every image
 * balances, a row deleted at the end — the insert's `null`, else the earliest row's `before`. `null` when no single walk can
 * use every row: a purged middle, a hand-written row.
 */
function startOf(sorted: readonly HistoryRecord[], ignored: ReadonlySet<string>): string | null {
  const balance = new Map<string, number>();
  for (const row of sorted) {
    const from = nodeOf(row.before, ignored);
    const to = nodeOf(row.after, ignored);
    balance.set(from, (balance.get(from) ?? 0) + 1);
    balance.set(to, (balance.get(to) ?? 0) - 1);
  }
  const starts = [...balance].filter(([, n]) => n === 1).map(([node]) => node);
  const odd = [...balance].filter(([, n]) => n !== 0 && n !== 1 && n !== -1);
  const ends = [...balance].filter(([, n]) => n === -1);
  if (odd.length > 0) return null;
  if (starts.length === 1 && ends.length === 1) return starts[0] ?? null;
  if (starts.length === 0 && ends.length === 0) {
    // A circuit: every life of the row closed. It began at an insert — the NULL image — whatever
    // `at` the delete carries (a transaction that began first and deleted last stamps the earlier).
    const hasInsert = sorted.some((row) => nodeOf(row.before, ignored) === 'null');
    return hasInsert ? 'null' : nodeOf(sorted[0]?.before, ignored);
  }
  return null;
}

/** By instant, chaining only inside one: the fallback when the rows make no single walk. */
function byInstant(
  sorted: readonly HistoryRecord[],
  ignored: ReadonlySet<string>,
): readonly HistoryRecord[] {
  const ordered: HistoryRecord[] = [];
  let current = 'null';
  for (let i = 0; i < sorted.length; ) {
    const instant = sorted[i]?.at.getTime();
    let end = i;
    while (end < sorted.length && sorted[end]?.at.getTime() === instant) end += 1;
    const group = sorted.slice(i, end);
    const chained = walk(group, current, ignored) ?? group;
    ordered.push(...chained);
    current = nodeOf(chained[chained.length - 1]?.after, ignored);
    i = end;
  }
  return ordered;
}

/**
 * `rows` in write order, numbered from 1. `ignored`: the parent's counting columns.
 *
 * The before→after chain decides, across EVERY row: `at` is each write's TRANSACTION start
 * (`now()`), so a transaction that began first and committed last carries the earlier `at` and the
 * later image. `at` orders only what the chain leaves open — which edge leaves an image first — and
 * the whole order when no single walk uses every row. The limit: an image revisited across
 * transactions (A→B→A→C) admits more than one walk, and the earliest-`at` edge is taken first.
 */
export function orderVersions(
  rows: readonly HistoryRecord[],
  ignored: ReadonlySet<string> = new Set(),
): readonly HistoryVersion[] {
  const sorted = [...rows].sort((a, b) => a.at.getTime() - b.at.getTime() || byRank(a, b));
  const start = sorted.length === 0 ? null : startOf(sorted, ignored);
  const chained =
    (start === null ? null : walk(sorted, start, ignored)) ?? byInstant(sorted, ignored);
  return chained.map((row, i) => ({ ...row, version: i + 1 }));
}
