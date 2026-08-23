// Single responsibility: what a foreign key *is* — where it points — and the two statements that
// add or drop one. `generate.ts` writes them and `drift.ts` compares them, and a generator that
// disagreed with a detector about whether two keys are the same key is drift on a correct database.

import { assert } from '@ultimat3/core';
import type { ForeignKeyDescription } from './introspect';

/**
 * `pg_constraint.confdeltype`. The catalog's vocabulary; a description holds the rule's name.
 *
 * A `Map`, because `raw` is a catalog string on every read: an object literal answered
 * `CATALOG_RULES['constructor']` with the `Object` FUNCTION, which left this `string | null`
 * function returning one into `compareForeignKeys`.
 */
const CATALOG_RULES: ReadonlyMap<string, string> = new Map(
  Object.entries({
    a: 'no action',
    c: 'cascade',
    r: 'restrict',
    n: 'set null',
    d: 'set default',
  }),
);

/**
 * One `on delete` vocabulary for both sides. The catalog spells the rule as a single character and
 * a description spells it out, so a comparison between them needs one of them translated — and
 * translating both through the same total function keeps it idempotent, which is what lets either
 * side be normalised without knowing where it came from.
 *
 * `no action` is `null`: Postgres records the default on **every** key, so reading it as a
 * declared rule reports a difference against every constraint whose snapshot never spelled one.
 */
export function onDeleteRule(raw: string | null): string | null {
  if (raw === null) return null;
  const named = CATALOG_RULES.get(raw) ?? raw.toLowerCase();
  return named === 'no action' ? null : named;
}

const WRITABLE = new Set(['cascade', 'restrict', 'set null', 'set default']);

/**
 * A key's identity: its columns, its target table, its target columns — never its name. Postgres
 * names an inline `references` clause `<table>_<column>_fkey` and a hand-written migration may have
 * said `constraint fk_posts_org`; a key pointing the same way under another name is the same key.
 *
 * Both lists stay ordered, because a composite key is an ordered pairing: `(a, b) references t (x,
 * y)` and `(b, a) references t (x, y)` are different constraints.
 */
export function foreignKeyTarget(key: ForeignKeyDescription): string {
  return JSON.stringify([[...key.columns], key.referencedTable, [...key.referencedColumns]]);
}

const quoted = (names: readonly string[]): string => names.map((name) => `"${name}"`).join(', ');

/**
 * A statement of its own, never a clause inside `create table`. Inline, the constraint is created
 * with the table, so the referenced table must already exist — and entity registration order is
 * the app's import order, which has nothing to say about which table a `references()` points at.
 * Two tables referencing each other cannot be expressed inline at all, in any order.
 *
 * The constraint is **named** here rather than left to Postgres' own convention, so the name the
 * snapshot beside it records is a name this migration wrote and not a name it guessed.
 *
 * `on delete` is written out, and it had never been: `entity()` has carried the option since 1.0,
 * it type-checked, and the clause it reached was `references "orgs" ("id");` — a declared cascade
 * that the database refuses the delete under instead. A rule Postgres does not have is
 * `X_INVARIANT` rather than DDL, the same discipline `createIndex` applies to an index naming no
 * column: `entity()`'s option is a closed union, so only a hand-built description can get here.
 */
export function addForeignKey(table: string, key: ForeignKeyDescription): string {
  const rule = onDeleteRule(key.onDelete);
  assert(
    rule === null || WRITABLE.has(rule),
    `foreign key "${key.name}" on "${table}" declares an unknown on delete rule`,
    `references(() => target.id, { onDelete: 'cascade' })   # cascade | restrict | set null`,
  );
  return (
    `alter table "${table}" add constraint "${key.name}" ` +
    `foreign key (${quoted(key.columns)}) ` +
    `references "${key.referencedTable}" (${quoted(key.referencedColumns)})` +
    `${rule === null ? '' : ` on delete ${rule}`};`
  );
}

/** The reverse. Dropping a constraint loses nothing the database cannot rebuild. */
export function dropForeignKey(table: string, constraint: string): string {
  return `alter table "${table}" drop constraint "${constraint}";`;
}
