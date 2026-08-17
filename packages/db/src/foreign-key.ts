// Single responsibility: what a foreign key *is* — where it points — and the two statements that
// add or drop one. `generate.ts` writes them and `drift.ts` compares them, and a generator that
// disagreed with a detector about whether two keys are the same key is drift on a correct database.

import type { ForeignKeyDescription } from './introspect';

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
 */
export function addForeignKey(table: string, key: ForeignKeyDescription): string {
  return (
    `alter table "${table}" add constraint "${key.name}" ` +
    `foreign key (${quoted(key.columns)}) ` +
    `references "${key.referencedTable}" (${quoted(key.referencedColumns)});`
  );
}

/** The reverse. Dropping a constraint loses nothing the database cannot rebuild. */
export function dropForeignKey(table: string, constraint: string): string {
  return `alter table "${table}" drop constraint "${constraint}";`;
}
