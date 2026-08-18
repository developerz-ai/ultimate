// The one field-type → widget table. Adding a column kind means adding a row here, so
// there is never a second opinion about how money or a timestamp is rendered — and an
// unmapped column is a loud X_ADMIN_FIELD_UNSUPPORTED at derive time, not a blank cell.

import type { AdminColumnFacts } from './entity-columns';
import { AdminFieldUnsupportedError } from './errors';

export type AdminFieldType =
  | 'text'
  | 'textarea'
  | 'number'
  | 'money'
  | 'boolean'
  | 'enum'
  | 'date'
  | 'timestamptz'
  | 'timezone'
  | 'locale'
  | 'json'
  | 'relation'
  | 'file';

export type AdminWidget =
  | 'text-input'
  | 'textarea'
  | 'number-input'
  | 'money'
  | 'checkbox'
  | 'select'
  | 'datetime'
  | 'timezone-picker'
  | 'locale-picker'
  | 'json-editor'
  | 'reference'
  | 'upload';

/**
 * A derived field: everything a list cell, a detail row, a form input, a filter, and an MCP
 * tool schema need, decided once at derive time. `resource.ts` builds these; nothing else
 * inspects a column.
 */
export interface AdminField {
  readonly entity: string;
  readonly name: string;
  readonly type: AdminFieldType;
  readonly widget: AdminWidget;
  /** i18n key, never a string. `admin.<entity>.field.<name>`. */
  readonly labelKey: string;
  readonly required: boolean;
  readonly readOnly: boolean;
  /** Never rendered, redacted in the audit diff. */
  readonly sensitive: boolean;
  readonly inList: boolean;
  readonly filterable: boolean;
  readonly sortable: boolean;
  readonly searchable: boolean;
  readonly values?: readonly string[];
  readonly currency?: string;
  readonly relation?: { readonly entity: string; readonly labelField?: string };
}

/** The table. Money always the Money widget; both date kinds always the DateTime widget. */
export const WIDGET_BY_FIELD_TYPE: Readonly<Record<AdminFieldType, AdminWidget>> = {
  text: 'text-input',
  textarea: 'textarea',
  number: 'number-input',
  money: 'money',
  boolean: 'checkbox',
  enum: 'select',
  date: 'datetime',
  timestamptz: 'datetime',
  timezone: 'timezone-picker',
  locale: 'locale-picker',
  json: 'json-editor',
  relation: 'reference',
  file: 'upload',
};

export function widgetFor(type: AdminFieldType): AdminWidget {
  return WIDGET_BY_FIELD_TYPE[type];
}

/**
 * Every kind `@ultimat3/entity` can put on a column, and nothing else: a name that no column
 * builder emits would be a widget nobody can reach. `text` is the entry the length rule below
 * then refines.
 *
 * The kinds an EXISTING schema brings (`bigint()`, `decimal()`, `date()`, `arrayOf()`) each map to
 * the widget that survives a round trip of the value the column itself produces, which is not
 * always the widget the Postgres type suggests:
 *
 * | kind | field type | why not the obvious one |
 * |---|---|---|
 * | `numeric` | `text` | the row value is the exact decimal STRING, and `number-input` renders anything that is not a JS number as null — a blanked field that saves the blank back |
 * | `bigint` | `text` | same reason, and it shipped as `number` before `bigint()` existed: the row value is decimal digits, because a JS `bigint` is what `JSON.stringify` throws on and a `number` loses everything past 2^53 — the range a legacy `int8` key lives in |
 * | `date` | `date` | a calendar date has no zone, so it takes the `precision: 'date'` branch (`<input type="date">`) rather than the instant one |
 * | `array` | `json` | `String(['a,b'])` and `String(['a','b'])` are the same string, and what a text input posts back is not an array at all |
 *
 * `bytea` is deliberately ABSENT. The `file` widget's value is a storage reference (`{ url, name }`
 * — see `uploadValue`), and the `Uint8Array` a `bytes()` column puts on the row is not one, so
 * mapping it would move the same refusal from derive time, where the fix names the edit, to every
 * render of every row. There is no `vector` row for the same reason there is no vector column.
 */
const FIELD_TYPE_BY_COLUMN_KIND: Readonly<Record<string, AdminFieldType>> = {
  uuid: 'text',
  text: 'textarea',
  char: 'text',
  boolean: 'boolean',
  integer: 'number',
  bigint: 'text',
  numeric: 'text',
  timestamptz: 'timestamptz',
  date: 'date',
  jsonb: 'json',
  array: 'json',
  money: 'money',
};

/**
 * Derivation order matters: a FK is a relation whatever its kind, and declared `values` mean
 * a select whatever its kind. Only then does the column kind get a vote — and a text column
 * with a declared max is one line, where an unbounded `text()` is prose.
 */
export function fieldTypeFromColumn(
  entity: string,
  field: string,
  column: AdminColumnFacts,
): AdminFieldType {
  if (column.references !== undefined) return 'relation';
  if (column.values !== undefined && column.values.length > 0) return 'enum';

  const mapped = FIELD_TYPE_BY_COLUMN_KIND[column.kind];
  if (mapped === undefined) {
    throw new AdminFieldUnsupportedError({
      entity,
      field,
      cause: `column kind "${column.kind}" has no admin widget`,
      fix: `adminResource(${entity}, { fields: { ${field}: { widget: 'json-editor' } } })  # or { hidden: true }`,
    });
  }
  return mapped === 'textarea' && column.length !== undefined ? 'text' : mapped;
}

/** `false` for kinds whose value is never worth a list column (blobs, big JSON, prose). */
export function listable(type: AdminFieldType): boolean {
  return type !== 'json' && type !== 'file' && type !== 'textarea';
}

/** Only indexed, unique, enum, boolean, and FK columns are offered as filters. */
export function filterable(type: AdminFieldType, column: AdminColumnFacts): boolean {
  if (column.index || column.unique || column.primaryKey) return true;
  return type === 'enum' || type === 'boolean' || type === 'relation';
}

/**
 * Sortable means "usable as the keyset cursor", so it is deliberately narrow: an ordered
 * scalar, or a text column with an index behind it. Sorting on an unindexed column would
 * turn every page of the admin into a sort of the whole table.
 */
export function sortable(type: AdminFieldType, column: AdminColumnFacts): boolean {
  if (type === 'number' || type === 'money' || type === 'date' || type === 'timestamptz') {
    return true;
  }
  if (type !== 'text') return false;
  return column.index || column.unique || column.primaryKey;
}

/**
 * The column kinds Postgres will accept a `LIKE` against. MEASURED on Postgres 17 (PGlite), one
 * statement per type: `text` and `char` answer rows; `uuid`, `numeric`, `bigint`, `integer`,
 * `date`, `timestamptz`, `jsonb`, `boolean` and `text[]` all answer
 * `operator does not exist: <type> ~~ unknown`, and `bytea` answers `Invalid input for bytea type`.
 *
 * It has to be the KIND and not the field type, because several kinds render in a text box and
 * only two of them can be searched: `adminSearch` issues one `contains` filter per searchable
 * field and the driver compiles `contains` to `<column> like $1` with NO cast
 * (`packages/entity/src/pg-sql.ts`), so a searchable column of any other kind makes the admin's
 * search box answer a database error rather than an empty result.
 */
const LIKE_ABLE_COLUMN_KINDS: ReadonlySet<string> = new Set(['text', 'char']);

/**
 * A text box over a column a `LIKE` can run against — both halves required. The type keeps an
 * enum or a relation out of the search index the way it always has; the kind keeps out the ones
 * that would throw.
 */
export function searchable(type: AdminFieldType, column: AdminColumnFacts): boolean {
  if (type !== 'text' && type !== 'textarea') return false;
  return LIKE_ABLE_COLUMN_KINDS.has(column.kind);
}
