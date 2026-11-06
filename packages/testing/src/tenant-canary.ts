// The read half of the tenant proof: what of tenant A a call by B must never hand back — every A
// row's canary and every A row's id, off the pass's one seed graph — and the walk that finds one in
// an output or an effect, by path. Taint, not heuristics: only values the seed itself wrote count.

import type { SeedGraph, SeedRow } from './seed-graph-plan';

/**
 * An id shorter than this is no taint: a serial `1` matches every count in every output. A seeded
 * uuid is 36; a short key is still caught through its row's canary.
 */
export const MIN_TAINT_ID_LENGTH = 8;

/** One tenant instance's taint: its rows, for the write half, and its markers, for the read half. */
export interface TenantTaint {
  readonly tenant: string;
  /** Every row the seed wrote for the instance, a child with no tenant column included. */
  readonly rows: readonly SeedRow[];
  /** Per row, its primary key as printed: the parts in key order, joined by `,`. */
  readonly ids: readonly string[];
  /** Lower-case: each row's canary, and each key part no row of anyone else shares. */
  readonly marks: readonly string[];
}

const keyParts = (key: Readonly<Record<string, unknown>>): readonly string[] =>
  Object.values(key).flatMap((part) =>
    typeof part === 'string' && part.length >= MIN_TAINT_ID_LENGTH ? [part.toLowerCase()] : [],
  );

/**
 * The taint of `tenant`: canaries of its rows that carry one in some column, and its key parts —
 * minus any key part a row outside the instance also has (a composite key naming a shared `plans`
 * row is no proof of whose row came back).
 */
export function tenantTaint(graph: SeedGraph, tenant: string): TenantTaint {
  // `canaries[i]` is `inserts[i]`'s: the graph writes the two together.
  const mine = graph.inserts.flatMap((row, i) => {
    const canary = graph.canaries[i];
    return row.tenant === tenant && canary?.entity === row.entity ? [{ row, canary }] : [];
  });
  const rows = mine.map((one) => one.row);
  const ids = mine.map((one) => Object.values(one.canary.key).map(String).join(','));
  const ours = mine.map((one) => one.canary);
  const elsewhere = new Set(
    graph.canaries.filter((canary) => canary.tenant !== tenant).flatMap((c) => keyParts(c.key)),
  );
  const marks = new Set<string>();
  for (const canary of ours) {
    if (canary.columns.length > 0) marks.add(canary.marker.toLowerCase());
    for (const part of keyParts(canary.key)) if (!elsewhere.has(part)) marks.add(part);
  }
  return { tenant, rows, ids, marks: [...marks] };
}

/** Every string a value holds, at any depth: what a caller HANDED in, so never a find. */
const stringsOf = (value: unknown, into: string[] = [], seen = new WeakSet<object>()): string[] => {
  if (typeof value === 'string') into.push(value.toLowerCase());
  else if (typeof value === 'object' && value !== null && !seen.has(value)) {
    seen.add(value);
    const entries = value instanceof Map ? [...value] : Object.entries(value);
    for (const [key, item] of entries) {
      stringsOf(key, into, seen);
      stringsOf(item, into, seen);
    }
    if (value instanceof Set) for (const item of value) stringsOf(item, into, seen);
  }
  return into;
};

/**
 * The marks a call by B can be caught by: the taint, minus every mark B's own input carried.
 * B was handed A's ids on purpose, so an echo of one (`{ id: input.postId, ok: false }`) proves
 * nothing; an id B was NOT handed, or any canary, proves the handler read A's row.
 */
export function huntedMarks(taint: TenantTaint, input: unknown): readonly string[] {
  const handed = stringsOf(input);
  return taint.marks.filter((mark) => !handed.some((text) => text.includes(mark)));
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
/** A key that is no identifier is data — an id, an address — so the path says `[*]`, never it. */
const step = (path: string, key: string): string =>
  IDENTIFIER.test(key) ? `${path}.${key}` : `${path}[*]`;

/**
 * Every path under `root` where a string holds a hunted mark — `output.items[0].url`. Object
 * keys are searched too (a record keyed by A's ids is a leak, `output[*]:key`); a path never holds
 * the value found, and the walk stops at a value seen twice.
 */
export function findTaint(value: unknown, root: string, marks: readonly string[]): string[] {
  const found: string[] = [];
  if (marks.length === 0) return found;
  const tainted = (text: string): boolean => {
    const lower = text.toLowerCase();
    return marks.some((mark) => lower.includes(mark));
  };
  const seen = new WeakSet<object>();
  const walk = (item: unknown, path: string): void => {
    if (typeof item === 'string') {
      if (tainted(item)) found.push(path);
      return;
    }
    if (typeof item !== 'object' || item === null || seen.has(item)) return;
    if (item instanceof Date || ArrayBuffer.isView(item)) return;
    seen.add(item);
    if (Array.isArray(item) || item instanceof Set) {
      for (const [i, one] of [...item].entries()) walk(one, `${path}[${i}]`);
      return;
    }
    const entries: [unknown, unknown][] =
      item instanceof Map ? [...item] : Object.entries(item as Record<string, unknown>);
    for (const [key, one] of entries) {
      const name = String(key);
      const here = step(path, name);
      if (tainted(name)) found.push(`${here}:key`);
      walk(one, here);
    }
  };
  walk(value, root);
  return found;
}
