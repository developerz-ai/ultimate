// Single responsibility: the objects a live database holds that replaying the migrations does not
// create — a trigger, function, view, type or sequence made by hand. `drift.ts` asks the same
// question of tables and columns against a snapshot; a snapshot records only what entities declare,
// so everything else is compared here, catalog against catalog, by identity and never by text.

import type { CatalogDescription } from './catalog';
import { FRAMEWORK_TABLE_PREFIX } from './drift';
import type { DriftDifference } from './drift-findings';
import { shellInertIdentifier } from './sql';

interface ObjectIdentity {
  /** The word `drop` takes: `trigger`, `function`, `view`, `materialized view`, `type`, `sequence`. */
  readonly kind: string;
  readonly name: string;
  /** What tells two objects of one name apart: a function's arguments. */
  readonly signature: string;
  readonly table: string | null;
}

/**
 * Identity only. Two servers spell one definition differently (`pg_get_viewdef` moved between
 * majors), and the live database is the operator's Postgres while the expected side is a replay
 * on the embedded one — a text comparison would report every view in a correct database.
 *
 * Tables are `diffSchema`'s (`unexpected-table`). Extensions are left out on purpose: an operator
 * installs `pg_stat_statements` on the server, and that is not the app's schema.
 */
function identities(catalog: CatalogDescription): readonly ObjectIdentity[] {
  const plain = (kind: string, name: string): ObjectIdentity => ({
    kind,
    name,
    signature: '',
    table: null,
  });
  return [
    ...catalog.types.map((type) => plain('type', type.name)),
    ...catalog.sequences.map((sequence) => plain('sequence', sequence.name)),
    ...catalog.views.map((view) =>
      plain(view.materialized ? 'materialized view' : 'view', view.name),
    ),
    ...catalog.functions.map((fn) => ({ ...plain('function', fn.name), signature: fn.arguments })),
    ...catalog.triggers.map((trigger) => ({
      ...plain('trigger', trigger.name),
      table: trigger.table,
    })),
  ];
}

/** What `shellInertIdentifier` refuses in a name, plus the controls a pasted line must not carry. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point.
const SIGNATURE_ACTIVE = /[`$\\\u0000-\u001f\u007f]/;

const keyOf = (object: ObjectIdentity): string =>
  [object.kind, object.table ?? '', object.name, object.signature].join('\u0000');

/**
 * The `drop` comes FIRST in the fix, and that order is the instruction: a migration that creates
 * an object the database already holds fails on `already exists`, so the hand-made copy has to go
 * before the migration that owns it can apply.
 */
function unexpectedObject(object: ObjectIdentity): DriftDifference {
  const name = shellInertIdentifier(object.name);
  const table = object.table === null ? null : shellInertIdentifier(object.table);
  const where = object.table === null ? '' : ` on table "${object.table}"`;
  const signature = object.signature === '' ? '' : `(${object.signature})`;
  // A function is dropped by its argument list, empty included: `drop function "add";` is
  // `42725 function name is not unique` while an overload lives beside it. The list is catalog
  // text (`pg_get_function_identity_arguments`), already quoted for SQL, so it is screened for
  // what a shell or a pasted line would read and never escaped.
  const args = object.kind === 'function' ? `(${object.signature})` : '';
  const spellable =
    name !== null &&
    (object.table === null || table !== null) &&
    !SIGNATURE_ACTIVE.test(object.signature);
  const drop = `drop ${object.kind} ${name}${args}${table === null ? '' : ` on ${table}`};`;
  return {
    kind: 'unexpected-object',
    table: object.table ?? object.name,
    column: null,
    cause: `${object.kind} "${object.name}"${signature}${where} exists in this database and no migration creates it`,
    fix: spellable
      ? `run ${drop} inside psql "$DATABASE_URL", then write its create statement into a ` +
        'migration and run x db migrate — or leave it dropped if nothing owns it'
      : 'drop it by hand, then write its create statement into a migration and run x db migrate ' +
        '— its name or arguments carry a backtick, a dollar sign, a quote, a backslash or ' +
        'whitespace, so ' +
        'no statement here can spell it',
  };
}

/**
 * Everything `live` holds that `expected` does not, framework bookkeeping excluded on the rule
 * `appTables()` states. One direction only: an object the migrations create and the database
 * lacks is a migration that has not run, which the ledger already reports.
 */
export function unexpectedObjects(
  live: CatalogDescription,
  expected: CatalogDescription,
): readonly DriftDifference[] {
  const known = new Set(identities(expected).map(keyOf));
  return identities(live)
    .filter((object) => !(object.table ?? object.name).startsWith(FRAMEWORK_TABLE_PREFIX))
    .filter((object) => !known.has(keyOf(object)))
    .map(unexpectedObject);
}
