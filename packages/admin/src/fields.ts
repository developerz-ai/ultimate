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
 */
const FIELD_TYPE_BY_COLUMN_KIND: Readonly<Record<string, AdminFieldType>> = {
  uuid: 'text',
  text: 'textarea',
  char: 'text',
  boolean: 'boolean',
  integer: 'number',
  bigint: 'number',
  timestamptz: 'timestamptz',
  jsonb: 'json',
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

export function searchable(type: AdminFieldType): boolean {
  return type === 'text' || type === 'textarea';
}
