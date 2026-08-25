// Single responsibility: what a generated migration declares it could NOT write, and how that
// reaches the file. A generator that silently emits less than the declaration is the defect this
// module exists against — ten invariants and nine defaults went missing between an entity and its
// own regenerated migration, and the `drift` gate step compares a source hash to a sidecar and
// never reads the SQL, so the loss was GREEN. A comment in the emitted `up` cannot be green.

import { assert } from '@ultimat3/core';
import { hasUnrenderedDefault } from './column-default';
import type { EntityDescriptionLike } from './entity-shape';

export interface UnrenderedDeclaration {
  /** Which half of the declaration reached no SQL. */
  readonly kind: 'default';
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
 * What the entities declare and this migration does not carry. One producer today: a column whose
 * description says `hasDefault` with no expression beside it, which is every non-`now()`,
 * non-`gen_random_uuid()` default until `@ultimat3/entity` projects `ColumnMeta.default`.
 *
 * Read off the ENTITIES and not off the plan, deliberately: a diff that emitted nothing for a
 * table because nothing about it moved still has to report a default the create statement never
 * carried, or the loss becomes invisible again on the second run.
 */
export function unrenderedOf(entities: readonly EntityDescriptionLike[]): UnrenderedDeclaration[] {
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
  }
  return entries;
}
