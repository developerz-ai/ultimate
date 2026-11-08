// A value for one column, read off the column's own declaration — its kind, nullability, enumerated
// values, length, money parts, default, `matches()` patterns and `json(schema)` — never off its
// name. Every candidate is run through the column's `$parse`, which refuses exactly what its CHECK
// refuses, so what survives is storable.

import { fnv1a } from '@ultimat3/core';
import type { ColumnMeta } from '@ultimat3/entity';
import type * as Sample from '@ultimat3/schema/sample';
import { patternSamples } from './seed-pattern-sample';

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
  /**
   * The `matches(/…/)` patterns the entity's invariants hold this column to (`declaredPatterns`).
   * Each one adds strings built from the pattern itself, so a rule no fixed shape meets is met.
   */
  readonly patterns?: readonly RegExp[] | undefined;
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
  const sized = meta.length === undefined ? shapes : [...shapes, ctx.canary.slice(0, meta.length)];
  return [...sized, ...fromPatterns(property, ctx)];
};

/** Strings drawn from each declared pattern, kept only where every other pattern agrees. */
const fromPatterns = (property: string, ctx: ValueContext): string[] => {
  const patterns = ctx.patterns ?? [];
  return patterns
    .flatMap((pattern) => patternSamples(pattern, `${property}:${ctx.canary}`))
    .filter((sample) => patterns.every((pattern) => pattern.test(sample)));
};

let loadedSampler: typeof Sample | undefined;

/**
 * `@ultimat3/schema/sample`, loaded on the first `json(schema)` column and never at import: this
 * module is on the barrel, and the walker is a dynamic-only dependency there (`CLAUDE.md`).
 * `require` and not `import()` because every caller of `candidatesFor` is synchronous.
 */
const sampler = (): typeof Sample => {
  loadedSampler ??= require('@ultimat3/schema/sample') as typeof Sample;
  return loadedSampler;
};

/**
 * Values the column's own schema accepts, seeded by the row so two rows differ and a rerun does
 * not; then the bare `{}`/`[]`, which a schema-less `jsonb` column stores.
 */
const jsonCandidates = (property: string, meta: ColumnMeta, ctx: ValueContext): unknown[] => {
  const schema = meta.schema;
  if (schema === undefined) return [{}, []];
  const { arbitrary, sampleInput, BOUNDARY_RUNS } = sampler();
  const seed = fnv1a(`${property}:${ctx.canary}`);
  return [
    arbitrary(schema, { seed, run: BOUNDARY_RUNS }),
    arbitrary(schema, { seed, run: 0 }),
    sampleInput(schema),
    {},
    [],
  ];
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
      return jsonCandidates(property, meta, ctx);
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
 * What every driver binds as SQL NULL — a JSON `null` included (`pg-row.ts` `bindable`): `t.json()`
 * accepts it and the sampler draws it, so a NOT NULL `jsonb` column must never be offered one.
 */
const storesAsSqlNull = (value: unknown): boolean => value === null || value === undefined;

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
    if (result === undefined || (meta.notNull && storesAsSqlNull(result.ok))) continue;
    if (!out.some((seen) => Bun.deepEquals(seen, result.ok))) out.push(result.ok);
  }
  return keepsPatternsFirst(out, ctx.patterns ?? []);
}

/**
 * Stable: what keeps every declared pattern moves ahead, so `factoriesFor`, which takes the FIRST
 * candidate and runs no solver, builds a row its own rules accept.
 */
const keepsPatternsFirst = (values: unknown[], patterns: readonly RegExp[]): unknown[] => {
  if (patterns.length === 0) return values;
  const keeps = (value: unknown): boolean =>
    typeof value === 'string' && patterns.every((pattern) => pattern.test(value));
  return [...values.filter(keeps), ...values.filter((value) => !keeps(value))];
};

/** Candidates offered verbatim (a factory's value), kept only where the column stores them. */
export function storable(column: SeedColumn, values: readonly unknown[]): readonly unknown[] {
  return values.flatMap((value) => {
    const result = parsed(column, value);
    return result === undefined ? [] : [result.ok];
  });
}
