// Single responsibility: what a generated migration declares it could NOT write, and how that
// reaches the file. A generator that silently emits less than the declaration is the defect this
// module exists against — ten invariants and nine defaults went missing between an entity and its
// own regenerated migration, and the `drift` gate step compares a source hash to a sidecar and
// never reads the SQL, so the loss was GREEN. A comment in the emitted `up` cannot be green.

import { assert } from '@ultimat3/core';
import { columnNamesConstraint } from './check-ddl';
import { hasUnrenderedDefault } from './column-default';
import type { EntityDescriptionLike, InvariantDescriptionLike } from './entity-shape';
import { findTable, type SchemaDescription, type TableDescription } from './introspect';
import { namesConstraint } from './invariant-ddl';

export interface UnrenderedDeclaration {
  /** Which half of the declaration reached no SQL. */
  readonly kind: 'default' | 'invariant';
  /** The physical table it was declared on. */
  readonly table: string;
  /** The column or the invariant it was declared on. */
  readonly name: string;
  /** What was declared and why nothing was written. One line. */
  readonly cause: string;
  /** The edit or the command that makes the next generation carry it. One line. */
  readonly fix: string;
}

/**
 * Refused, not sanitised: a `\n` inside a `--` line comment ENDS the comment, so a cause carrying
 * one would put the rest of itself into the migration as real SQL. Every value that reaches here
 * is built from identifiers this generator already validated, so this is the assertion that keeps
 * that true rather than a filter that quietly rewrites text an author has to act on.
 */
function commentLine(text: string): string {
  assert(
    !/[\r\n]/.test(text),
    `a migration comment may not span lines: ${JSON.stringify(text)}`,
    'report this — a validated identifier reached the comment renderer carrying a newline',
  );
  return text;
}

/**
 * The block that goes at the TOP of `up`, or nothing at all. Nothing at all is the point: a marker
 * on every migration marks none, which is the rule `destructive.ts` already states for its own.
 *
 * Comments, never a refusal. `x db gen` refusing here would be a generator no app with a
 * `.default('draft')` could run at all — the whole tree is in that state until `@ultimat3/entity`
 * projects the expression — and a migration nobody can generate repairs nothing. The comment
 * survives into the committed file, where a reviewer and the next agent both read it, and
 * `GeneratedMigration.unrendered` carries the same list for a caller that would rather refuse.
 */
export function unrenderedComment(entries: readonly UnrenderedDeclaration[]): string {
  if (entries.length === 0) return '';
  const header =
    `-- UNRENDERED: ${entries.length} declaration${entries.length === 1 ? '' : 's'} reached no SQL. ` +
    'This migration is SMALLER than the entities declare.';
  const lines = entries.flatMap((entry) => [
    commentLine(`--   ${entry.kind} on "${entry.table}"."${entry.name}": ${entry.cause}`),
    commentLine(`--     fix: ${entry.fix}`),
  ]);
  return [commentLine(header), ...lines, ''].join('\n');
}

/**
 * A rule the app still declares and this migration TAKES AWAY. An `assert` reaches no SQL by
 * design — `sql: null` says only the app can judge it — so on its own it is not a loss, and
 * reporting every one would put a marker on nearly every app's every migration, which marks none.
 *
 * It becomes a loss the moment a migration RECORDED the rule as a real CHECK, because `checkPlan`
 * drops a recorded check nothing declares: regenerating then deletes the database's half of a rule
 * the entity still states — and it earns no `-- destructive:` marker of its own, because
 * `destructive.ts` excludes `drop constraint` by name on the argument that the database rebuilds
 * it, which here nothing does. Measured on `examples/dummy`: five constraints out of
 * `0001_init.sql` dropped in one run, three of them declared as asserts and reported by this, and
 * `unrendered` was empty — so `@ultimat3/cli`'s `repairFix` handed out
 * `x db gen "drop post_slug_shape"` — the command that performs the loss — as the repair for it.
 *
 * Self-clearing, which is what keeps it off every later file: once the drop is applied and the new
 * sidecar written, nothing records the check and the next generation reports nothing.
 */
function unrenderedInvariant(
  entity: EntityDescriptionLike,
  invariant: InvariantDescriptionLike,
  recorded: string,
): UnrenderedDeclaration {
  return {
    kind: 'invariant',
    table: entity.table,
    // The RECORDED name, never the rule's: it is the string in this migration's own `drop
    // constraint`, in the sidecar, and in the drift finding a caller matches this entry against.
    name: recorded,
    cause:
      `the entity declares "${invariant.name}" as an assert — a rule only the app can judge — ` +
      'and this migration drops the CHECK a migration recorded for it',
    fix:
      `invariant('${invariant.name}', …)   # express it in SQL to keep the CHECK — ` +
      'an assert has none, so the next x db gen drops it',
  };
}

/** Every recorded CHECK on this table that an `assert` still declares and this run would drop. */
function droppedAsserts(
  entity: EntityDescriptionLike,
  live: TableDescription | undefined,
): UnrenderedDeclaration[] {
  const recorded = live?.checks ?? [];
  if (recorded.length === 0) return [];
  const entries: UnrenderedDeclaration[] = [];
  for (const invariant of entity.invariants ?? []) {
    // `sql !== null` beside the kind, the pair `hasJsOnlyInvariant` already reads: a description
    // carrying an expression is rendered by `declaredChecks` whatever its kind claims.
    if (invariant.kind !== 'assert' || invariant.sql !== null) continue;
    for (const check of recorded) {
      if (!namesConstraint(entity.table, invariant, check.name)) continue;
      // A recorded check one of this entity's COLUMNS still declares is not being dropped — the two
      // naming conventions collide on `<table>_<column>_check` when an assert is named after a
      // column, and only what this run DECLARES can tell the two apart.
      if (columnNamesConstraint(entity, check.name)) continue;
      entries.push(unrenderedInvariant(entity, invariant, check.name));
    }
  }
  return entries;
}

/**
 * What the entities declare and this migration does not carry. Two producers, and they are one
 * question — "is this migration smaller than the declaration?" — never two:
 *
 * - a column whose description says `hasDefault` with no expression beside it, which is every
 *   non-`now()`, non-`gen_random_uuid()` default until `@ultimat3/entity` projects
 *   `ColumnMeta.default`;
 * - an `assert` invariant whose CHECK a previous migration recorded, which this run drops.
 *
 * The defaults half is read off the ENTITIES and not off the plan, deliberately: a diff that
 * emitted nothing for a table because nothing about it moved still has to report a default the
 * create statement never carried, or the loss becomes invisible again on the second run. The
 * invariants half needs `current` for the opposite reason — an assert with nothing recorded behind
 * it is not a loss at all, and the recorded schema is the only thing that can tell the two apart.
 *
 * `current` is REQUIRED and may be `undefined`: a caller with no recorded schema (the first
 * migration) has to say so, because the alternative is an argument nobody passes and a blind
 * answer nobody notices — which is exactly how five drops shipped under an empty list.
 */
export function unrenderedOf(
  entities: readonly EntityDescriptionLike[],
  current: SchemaDescription | undefined,
): UnrenderedDeclaration[] {
  const entries: UnrenderedDeclaration[] = [];
  for (const entity of entities) {
    for (const column of entity.columns) {
      if (!hasUnrenderedDefault(column)) continue;
      entries.push({
        kind: 'default',
        table: entity.table,
        name: column.column,
        cause: 'the entity description carries hasDefault with no expression beside it',
        fix:
          'project ColumnMeta.default onto ColumnDescription in ' +
          'packages/entity/src/describe.ts, then re-run x db gen',
      });
    }
    entries.push(
      ...droppedAsserts(
        entity,
        current === undefined ? undefined : findTable(current, entity.table),
      ),
    );
  }
  return entries;
}
