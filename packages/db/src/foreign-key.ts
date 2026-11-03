// Single responsibility: what a foreign key *is* — where it points — and the two statements that
// add or drop one. `generate.ts` writes them and `drift.ts` compares them, and a generator that
// disagreed with a detector about whether two keys are the same key is drift on a correct database.

import { assert } from '@ultimat3/core';
import type { ForeignKeyDescription } from './introspect';
import { identifier } from './sql';

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
 * `set null (a, b)`: only those columns go, the form a composite key needs to keep its other half
 * (Postgres 15+). The list is the rule's own text in a description and in the snapshot, so a key
 * that changes it reads as a changed rule, and `introspectSchema()` answers in the same spelling.
 */
const SET_NULL_COLUMNS = /^set null \((.+)\)$/;

/** The clause for a screened rule: `identifier` for each name, never the text as it arrived. */
const ruleClause = (rule: string | null): string => {
  if (rule === null) return '';
  const listed = SET_NULL_COLUMNS.exec(rule)?.[1];
  if (listed === undefined) return ` on delete ${rule}`;
  return ` on delete set null (${quoted(listed.split(',').map((name) => name.trim()))})`;
};

/** Whether a rule is one `addClause` may write: a listed column has to be one of the key's own. */
const isWritable = (rule: string, key: ForeignKeyDescription): boolean => {
  const listed = SET_NULL_COLUMNS.exec(rule)?.[1];
  if (listed === undefined) return WRITABLE.has(rule);
  return listed.split(',').every((name) => key.columns.includes(name.trim()));
};

/**
 * The two ends of a `references()`, which entity renders as `"<table>.<column>"`. Read once: the
 * clause that writes the constraint and the snapshot that records it must not disagree about what
 * it points at, or drift reports a key the database holds exactly as declared.
 */
export function referenceParts(references: string): readonly [string, string] {
  const [table = references, column = 'id'] = references.split('.');
  return [table, column];
}

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

/**
 * Which constraint, on which table — a key's NAME, where `foreignKeyTarget` is its meaning.
 *
 * The two exist for opposite questions and neither substitutes for the other. Drift asks whether
 * two keys point the same way and must ignore the name; a plan that has already DROPPED a
 * constraint asks whether this is that exact constraint, which is the name and nothing else. The
 * table is in it because two tables may each hold a `..._org_id_fkey`, and `checkPlan`'s
 * `predropped` set is the same shape one file over.
 */
export function keyId(table: string, constraint: string): string {
  return JSON.stringify([table, constraint]);
}

/**
 * Through `identifier`, never `"${…}"` — the package's one rule, which every name this file writes
 * now goes through. A name that closes its own quote produced a real `drop table` through
 * `generateMigration` once already, out of `columnClause`, and every name below arrives the same
 * way: from a projection this package cannot typecheck, or from a `.snapshot.json` on disk that
 * anything may edit. Being unreachable with a hostile name today is a property of the CALLERS, not
 * of this file, and it survives exactly until the next refactor.
 */
const quoted = (names: readonly string[]): string =>
  names.map((name) => identifier(name).text).join(', ');

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
export function addForeignKey(
  table: string,
  key: ForeignKeyDescription,
  options: { readonly notValid?: boolean } = {},
): string {
  return (
    `alter table ${identifier(table).text} ${addClause(table, key)}` +
    `${options.notValid === true ? ' not valid' : ''};`
  );
}

/** The `add constraint …` clause alone, with the rule screened. Both statement forms end in it. */
function addClause(table: string, key: ForeignKeyDescription): string {
  const rule = onDeleteRule(key.onDelete);
  assert(
    rule === null || isWritable(rule, key),
    `foreign key "${key.name}" on "${table}" declares an unknown on delete rule`,
    `references(() => target.id, { onDelete: 'cascade' })   # cascade | restrict | set null`,
  );
  return (
    `add constraint ${identifier(key.name).text} foreign key (${quoted(key.columns)}) ` +
    `references ${identifier(key.referencedTable).text} (${quoted(key.referencedColumns)})` +
    ruleClause(rule)
  );
}

/**
 * The deferred step's add: `not valid`, so it scans nothing and new writes are held to it at once.
 *
 * One ALTER and not a drop beside an add. `add constraint` has no `if not exists`, so the drop is
 * what makes the step re-runnable — and two statements would each take a transaction of their own
 * (`migration-step.ts`), leaving a same-named rebuild with no key at all between them.
 */
export function replaceForeignKeyNotValid(table: string, key: ForeignKeyDescription): string {
  return (
    `alter table ${identifier(table).text} drop constraint if exists ${identifier(key.name).text}, ` +
    `${addClause(table, key)} not valid;`
  );
}

/**
 * Scans the rows a `not valid` constraint let stand, under SHARE UPDATE EXCLUSIVE on the table:
 * reads and writes keep flowing. On a constraint that is already valid it does nothing, so a step
 * failing after this statement re-runs it harmlessly.
 */
export function validateConstraint(table: string, name: string): string {
  return `alter table ${identifier(table).text} validate constraint ${identifier(name).text};`;
}

/** The reverse. Dropping a constraint loses nothing the database cannot rebuild. */
export function dropForeignKey(table: string, constraint: string): string {
  return `alter table ${identifier(table).text} drop constraint ${identifier(constraint).text};`;
}

/** The deferred step's drop, re-runnable: the step re-runs from its first statement on a failure. */
export function dropForeignKeyIfExists(table: string, constraint: string): string {
  return `alter table ${identifier(table).text} drop constraint if exists ${identifier(constraint).text};`;
}

/**
 * What a `down` says in place of an `add constraint` it cannot run: the key's table or its target
 * is dropped by this migration, so there is nothing to add the constraint back onto.
 *
 * ONE text, two writers — `foreign-key-plan.ts`'s `unrestorableDrop` (a key pointing at a doomed
 * table) and `retype-keys.ts`'s `restore` (a key a retype moved aside whose ends are doomed).
 * They spelled the same fact two ways and had already drifted, so an operator reading a failed
 * rollback saw whichever module emitted last. It lives here because both import this module and
 * neither imports the other.
 *
 * Every name goes through `identifier`, including `gone`: a `--` comment ends at the first
 * newline, so a name holding one puts a second command on the line after it.
 */
export function unrestorableNote(table: string, constraint: string, gone: string): string {
  return (
    `-- constraint ${identifier(constraint).text} on ${identifier(table).text} ` +
    `cannot be restored; ${identifier(gone).text} is gone`
  );
}
