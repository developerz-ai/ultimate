// The one field-type → widget table. Adding a column kind means adding a row here, so
// there is never a second opinion about how money or a timestamp is rendered — and an
// unmapped column is a loud X_ADMIN_FIELD_UNSUPPORTED at derive time, not a blank cell.

import { AdminFieldUnsupportedError } from './errors';
import type { AdminColumn } from './registry';

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

/** Column types that map straight through, keyed by the SQL type name lowercased. */
const FIELD_TYPE_BY_SQL_TYPE: Readonly<Record<string, AdminFieldType>> = {
  text: 'textarea',
  varchar: 'text',
  'character varying': 'text',
  char: 'text',
  citext: 'text',
  uuid: 'text',
  slug: 'text',
  email: 'text',
  url: 'text',
  int: 'number',
  int2: 'number',
  int4: 'number',
  int8: 'number',
  integer: 'number',
  smallint: 'number',
  bigint: 'number',
  serial: 'number',
  numeric: 'number',
  decimal: 'number',
  real: 'number',
  'double precision': 'number',
  money: 'money',
  bool: 'boolean',
  boolean: 'boolean',
  enum: 'enum',
  date: 'date',
  timestamptz: 'timestamptz',
  'timestamp with time zone': 'timestamptz',
  timestamp: 'timestamptz',
  json: 'json',
  jsonb: 'json',
  timezone: 'timezone',
  locale: 'locale',
  file: 'file',
  upload: 'file',
  bytea: 'file',
};

/**
 * Derivation order matters: a FK is a relation whatever its SQL type, a column carrying a
 * currency is money whatever its SQL type, and declared `values` mean a select. Only then
 * does the SQL type name get a vote.
 */
export function fieldTypeFromColumn(
  entity: string,
  field: string,
  column: AdminColumn,
): AdminFieldType {
  if (column.references !== undefined) return 'relation';
  if (column.currency !== undefined) return 'money';
  if (column.values !== undefined && column.values.length > 0) return 'enum';

  const sqlType = column.type.toLowerCase();
  const mapped = FIELD_TYPE_BY_SQL_TYPE[sqlType];
  if (mapped === undefined) {
    throw new AdminFieldUnsupportedError({
      entity,
      field,
      cause: `column type "${column.type}" has no admin widget`,
      fix: `adminResource(${entity}, { fields: { ${field}: { widget: 'json-editor' } } })  # or { hidden: true }`,
    });
  }
  if (mapped === 'textarea' && column.multiline === false) return 'text';
  if (mapped === 'text' && column.multiline === true) return 'textarea';
  return mapped;
}

/** `false` for kinds whose value is never worth a list column (blobs, big JSON, prose). */
export function listable(type: AdminFieldType): boolean {
  return type !== 'json' && type !== 'file' && type !== 'textarea';
}

/** Only indexed, unique, enum, boolean, and FK columns are offered as filters. */
export function filterable(type: AdminFieldType, column: AdminColumn): boolean {
  if (column.index === true || column.unique === true || column.primaryKey === true) return true;
  return type === 'enum' || type === 'boolean' || type === 'relation';
}

/**
 * Sortable means "usable as the keyset cursor", so it is deliberately narrow: an ordered
 * scalar, or a text column with an index behind it. Sorting on an unindexed column would
 * turn every page of the admin into a sort of the whole table.
 */
export function sortable(type: AdminFieldType, column: AdminColumn): boolean {
  if (type === 'number' || type === 'money' || type === 'date' || type === 'timestamptz') {
    return true;
  }
  if (type !== 'text') return false;
  return column.index === true || column.unique === true || column.primaryKey === true;
}

export function searchable(type: AdminFieldType): boolean {
  return type === 'text' || type === 'textarea';
}
