// Single responsibility: which columns this migration RETYPES, and which recorded FOREIGN KEYS
// that breaks — the one answer to both, computed over the whole schema and above `diffTable`.
//
// **Why above `diffTable`, and not inside it like every other dependent.** Postgres re-checks a
// key's two ends against each other on every `alter column … type` and cannot rebuild one whose
// sides stopped matching: measured on 18.4, `42804 foreign key constraint "rk_posts_org_code_fkey"
// cannot be implemented — Key columns "org_code" … and "code" … are of incompatible types: integer
// and text`, thrown by the ALTER itself, inside `ROLE=migrate`, with the ledger recording nothing.
// The constraint that breaks is recorded on the table that OWNS it, which for a retype of the
// key's TARGET is a different entity's record — `diffTable(orgs)` is handed `orgs`'s row and can
// never see `posts.foreignKeys`. So the retype set is derived once, from `entities` and `current`
// together, and `retypeColumn` READS it rather than deciding again: two answers to "is this column
// being retyped" is the axiom-1 split this package has spent the week closing.
//
// **Over-approximated on purpose, the rule `retype-dependents.ts` states.** Whether two types keep
// an equality operator between them is operator resolution, which is exactly the knowledge a
// generator with no database cannot have — `varchar(80)` and `text` share one, `integer` and
// `text` do not. A key moved aside that did not need to be is one `add constraint` re-validating a
// table the ALTER beside it is already rewriting under ACCESS EXCLUSIVE; a key missed is the
// release phase failing with the server's words and none of the entity's.
//
// **What it cannot see.** A key the recorded schema does not hold — a hand-written migration's,
// or one from a sidecar written before `foreignKeys` was recorded — is invisible here and still
// `42804`, the same construction limit `x db gen` has against a hand-added expression index. And
// re-adding the key is still the SERVER's judgement: an entity that retypes one end and not the
// other declares a pairing Postgres has no operator for, and the `add constraint` at the end of
// `up` is where that is said. Refusing it here would need the type knowledge two paragraphs up.

import type { EntityDescriptionLike } from './entity-shape';
import { addForeignKey, dropForeignKey, keyId } from './foreign-key';
import type { Plan } from './foreign-key-plan';
import { isGenerated } from './generated-column';
import type { ForeignKeyDescription, SchemaDescription, TableDescription } from './introspect';
import { findTable } from './introspect';
import { identifier } from './sql';
import { sqlType } from './sql-type';

/** Table name to the columns whose physical type this migration moves. Empty entries are omitted. */
export type RetypedColumns = ReadonlyMap<string, ReadonlySet<string>>;

/** The columns of one table this migration retypes — `retypeColumn`'s own read of the set above. */
export function retypedIn(retyped: RetypedColumns, table: string): ReadonlySet<string> {
  return retyped.get(table) ?? new Set<string>();
}

/**
 * Every plain `alter column … type` this migration will emit, before any of them is written.
 *
 * A GENERATED column is deliberately absent: `generated-column.ts` owns every statement one of
 * them produces, and its plain -> generated path is a `drop column` that takes the key with it
 * rather than an ALTER that trips over it. That gap is real and is named in `generated-column.ts`.
 */
export function retypedColumns(
  entities: readonly EntityDescriptionLike[],
  current: SchemaDescription,
): RetypedColumns {
  const moved = new Map<string, ReadonlySet<string>>();
  for (const entity of entities) {
    const live = findTable(current, entity.table);
    if (live === undefined) continue;
    const recorded = new Map(live.columns.map((column) => [column.name, column]));
    const columns = new Set<string>();
    for (const column of entity.columns) {
      const held = recorded.get(column.column);
      if (held === undefined) continue;
      if (isGenerated(column) || held.generated !== undefined) continue;
      if (held.dataType !== sqlType(column.kind)) columns.add(column.column);
    }
    if (columns.size > 0) moved.set(entity.table, columns);
  }
  return moved;
}

/** Whether either end of `key` sits on a column this migration retypes. `owner` owns the key. */
function breaksOn(key: ForeignKeyDescription, owner: string, retyped: RetypedColumns): boolean {
  const own = retyped.get(owner);
  if (own !== undefined && key.columns.some((column) => own.has(column))) return true;
  const target = retyped.get(key.referencedTable);
  return target !== undefined && key.referencedColumns.some((column) => target.has(column));
}

/**
 * Drop every recorded key a retype breaks, restore it in `down`, and answer which names were moved.
 *
 * The two statements go in the plan's OWN buckets and not beside the ALTER, because the drop has
 * to precede every alter in the migration and the restore has to follow every one of them — both
 * ends of a key can move, in two different entities' diffs. `preAlters` is merged at the very top
 * of `up` and at the very FRONT of `down`, which reversal turns into the very end: so the reversed
 * script reads drop-the-new-key, retype both ends back, add the recorded key. Restoring it any
 * earlier is `42804` in the other direction.
 *
 * What comes back in `up` is not written here at all: `foreignKeyPlan` reads the returned set,
 * treats a moved key as one the schema does not record, and adds the DECLARED key in the
 * `constraints` bucket that already runs after every table statement. That is what makes the three
 * outcomes fall out of code that already exists — still declared (added back), no longer declared
 * (gone, exactly as the removal arm would have left it), and declared with a new `on delete` rule
 * (added back carrying it) — instead of three branches restating them here.
 */
export function moveKeysAside(
  current: SchemaDescription,
  retyped: RetypedColumns,
  doomed: ReadonlySet<string>,
  preAlters: Plan,
): ReadonlySet<string> {
  const moved = new Set<string>();
  for (const table of current.tables) {
    for (const key of table.foreignKeys) {
      if (!breaksOn(key, table.name, retyped)) continue;
      moved.add(keyId(table.name, key.name));
      preAlters.up.push(dropForeignKey(table.name, key.name));
      preAlters.down.push(restore(table, key, doomed));
    }
  }
  return moved;
}

/**
 * The `down` half. A key whose own table or whose target is being dropped has no `add constraint`
 * that could run at all, so it gets the note `unrestorableDrop` already gives one — through
 * `identifier`, because a `--` comment ends at the first newline and a name holding one would put
 * a second command on the line after it.
 */
function restore(
  table: TableDescription,
  key: ForeignKeyDescription,
  doomed: ReadonlySet<string>,
): string {
  if (!doomed.has(table.name) && !doomed.has(key.referencedTable)) {
    return addForeignKey(table.name, key);
  }
  return (
    `-- constraint ${identifier(key.name).text} on ${identifier(table.name).text} ` +
    'cannot be restored; a table it needs is gone'
  );
}
