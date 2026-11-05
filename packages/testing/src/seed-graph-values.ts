// A value for one column, read off the column's own declaration — its kind, nullability, enumerated
// values, length, money parts and default — never off its name. Every candidate is run through the
// column's `$parse`, which refuses exactly what its CHECK refuses, so what survives is storable.

import type { ColumnMeta } from '@ultimat3/entity';

/** A column as `entity()` declares it, structurally: this barrel never loads `@ultimat3/entity`. */
export interface SeedColumn {
  readonly $meta: ColumnMeta;
  $parse(value: unknown): unknown;
}

/** What one row lends every column it generates: its place, its canary and its id stream. */
export interface ValueContext {
  /** 1-based and unique per table, so a value derived from it is unique per table. */
  readonly ordinal: number;
  /** The row's canary: lower-case hex, so it survives a slug or a handle pattern. */
  readonly canary: string;
  /** Declaration position of the column, so two instants on one row are ordered as declared. */
  readonly position: number;
  uuid(): string;
}

/** Fixed, never `Date.now()`: the same seed must produce the same bytes on any day. */
const BASE_INSTANT = Date.UTC(2026, 0, 1);
const HOUR = 3_600_000;
const MINUTE = 60_000;

/** ISO-4217 codes a money column is offered, in order; a rule pairing it with an enum picks one. */
const CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD'] as const;

export const isSeedColumn = (value: unknown): value is SeedColumn =>
  typeof value === 'object' &&
  value !== null &&
  '$meta' in value &&
  typeof value.$meta === 'object' &&
  value.$meta !== null &&
  '$parse' in value &&
  typeof value.$parse === 'function';

const rotate = <T>(values: readonly T[], by: number): readonly T[] =>
  values.length === 0 ? values : values.map((_, i) => values[(i + by) % values.length] as T);

/**
 * Shapes, not guesses: the declared rule (a pattern, `contains('@')`) picks among them, and the
 * property only makes the value readable. Each carries the canary, so each is unique per row.
 */
const textCandidates = (property: string, meta: ColumnMeta, ctx: ValueContext): unknown[] => {
  const word = property.toLowerCase().replace(/[^a-z0-9]/g, '') || 'value';
  const kebab = property
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '');
  const shapes = [
    `${kebab || word}-${ctx.canary}`,
    `${word}${ctx.canary}`,
    `${word}_${ctx.canary}`,
    `${word}.${ctx.canary}@seed.test`,
    `https://seed.test/${word}/${ctx.canary}`,
    ctx.canary,
  ];
  return meta.length === undefined ? shapes : [...shapes, ctx.canary.slice(0, meta.length)];
};

const byKind = (property: string, meta: ColumnMeta, ctx: ValueContext): unknown[] => {
  const n = ctx.ordinal;
  if (meta.values !== undefined) return [...rotate(meta.values, n - 1)];
  switch (meta.kind) {
    case 'uuid':
      return [ctx.uuid()];
    case 'text':
    case 'char':
      return textCandidates(property, meta, ctx);
    case 'boolean':
      return [false, true];
    case 'integer':
      return [n, 1, 0];
    case 'bigint':
      return [String(n), '1', '0'];
    case 'numeric':
      return [String(n), '1', '0'];
    case 'timestamptz':
      return [new Date(BASE_INSTANT + n * HOUR + ctx.position * MINUTE)];
    case 'date':
      return [`2026-01-${String((n % 28) + 1).padStart(2, '0')}`];
    case 'jsonb':
      return [{}, []];
    case 'bytea':
      return [new Uint8Array([n % 256])];
    case 'array':
      return [[]];
    case 'money':
      return CURRENCIES.map((currency) => ({ minor: n * 100, currency }));
  }
};

const parsed = (column: SeedColumn, value: unknown): { readonly ok: unknown } | undefined => {
  try {
    return { ok: column.$parse(value) };
  } catch {
    // A refusal is the answer "not this one": the next candidate is tried, and an empty list is
    // the caller's X_SEED_GRAPH_UNSATISFIED.
    return undefined;
  }
};

/**
 * Every storable value for this column, most plausible first: the declared default, then what the
 * kind offers, then `null` when the column allows it. Empty means nothing generated is storable.
 */
export function candidatesFor(
  property: string,
  column: SeedColumn,
  ctx: ValueContext,
): readonly unknown[] {
  const meta = column.$meta;
  const declared = meta.default?.kind === 'value' ? [meta.default.value] : [];
  const raw = [...declared, ...byKind(property, meta, ctx), ...(meta.notNull ? [] : [null])];
  const out: unknown[] = [];
  for (const value of raw) {
    const result = parsed(column, value);
    if (result !== undefined && !out.some((seen) => Bun.deepEquals(seen, result.ok))) {
      out.push(result.ok);
    }
  }
  return out;
}

/** Candidates offered verbatim (a factory's value), kept only where the column stores them. */
export function storable(column: SeedColumn, values: readonly unknown[]): readonly unknown[] {
  return values.flatMap((value) => {
    const result = parsed(column, value);
    return result === undefined ? [] : [result.ok];
  });
}
