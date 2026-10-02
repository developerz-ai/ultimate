// Single responsibility: the objects a live database holds that replaying the migrations does not
// create — a trigger, function, view, type or sequence made by hand. `drift.ts` asks the same
// question of tables and columns against a snapshot; a snapshot records only what entities declare,
// so everything else is compared here, catalog against catalog, by identity and never by text.

import type { CatalogDescription } from './catalog';
import { psqlCommand } from './dependent-view';
import { FRAMEWORK_TABLE_PREFIX } from './drift';
import { byHand, type DriftDifference } from './drift-findings';
import { literal, shellInertIdentifier } from './sql';

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

/** The psql command that PRINTS a kind's definition — what a migration's create statement is copied from. */
const SHOW = Object.freeze<Record<string, string>>({
  view: '\\d+',
  'materialized view': '\\d+',
  type: '\\dT+',
  sequence: '\\d',
  // A trigger has no command of its own: `\d` on its table lists it, definition included.
  trigger: '\\d',
});

/**
 * A function's definition, asked for by the two facts the catalog gave: its name and its identity
 * arguments. Not `\sf name(args)`: that parses a TYPE list, and the identity arguments carry the
 * parameter NAMES (`a text`), which it answers with a syntax error — measured on 17. Both values
 * are data, so both go through `literal()`.
 */
const showFunction = (object: ObjectIdentity): string =>
  'select pg_get_functiondef(oid) from pg_proc where pg_function_is_visible(oid) and ' +
  `proname = ${literal(object.name).text} and ` +
  `pg_get_function_identity_arguments(oid) = ${literal(object.signature).text}`;

/**
 * The fix is ONE command a shell runs, and it is the harmless one: it prints the object's
 * definition. The repair is the comment, in the order it has to happen — copy the definition into
 * a migration, drop the hand-made copy (a migration creating an object the database already holds
 * fails on `already exists`), then migrate. It used to lead with `run drop …; inside psql`: prose
 * no shell runs, whose first step destroyed the definition the second step needed.
 */
function unexpectedObject(object: ObjectIdentity): DriftDifference {
  const name = shellInertIdentifier(object.name);
  const table = object.table === null ? null : shellInertIdentifier(object.table);
  const where = object.table === null ? '' : ` on table "${object.table}"`;
  const signature = object.signature === '' ? '' : `(${object.signature})`;
  // A function is named by its argument list, empty included: `drop function "add";` is
  // `42725 function name is not unique` while an overload lives beside it. The list is catalog
  // text (`pg_get_function_identity_arguments`), already quoted for SQL, so it is screened for
  // what a shell or a pasted line would read and never escaped.
  const args = object.kind === 'function' ? `(${object.signature})` : '';
  const spellable =
    name !== null &&
    (object.table === null || table !== null) &&
    !SIGNATURE_ACTIVE.test(object.signature);
  const cause = `${object.kind} "${object.name}"${signature}${where} exists in this database and no migration creates it`;
  const kind = 'unexpected-object';
  const base = { kind, table: object.table ?? object.name, column: null, cause } as const;
  if (!spellable) {
    return {
      ...base,
      fix: byHand(
        'copy the definition of the object this difference names into a migration as a create ' +
          'statement, then drop it',
        'its name or arguments carry a backtick, a dollar sign, a quote, a backslash or ' +
          'whitespace, so no statement here can spell it',
      ),
    };
  }
  const drop = `drop ${object.kind} ${name}${args}${table === null ? '' : ` on ${table}`};`;
  // The comment repeats the statement only when it holds no `'`: a shell that does not read `#`
  // as a comment would open a quote on one. The command is safe either way (`psqlCommand`).
  const spoken = drop.includes("'") ? `drop ${object.kind} on it` : drop;
  const show = psqlCommand(
    object.kind === 'function'
      ? showFunction(object)
      : `${SHOW[object.kind] ?? '\\d'} ${table ?? name}`,
  );
  return {
    ...base,
    fix:
      `${show}   # no migration creates it: copy its definition into a migration as a create ` +
      `statement, run ${spoken} here, then x db migrate — or only drop it if nothing owns it`,
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
