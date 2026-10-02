// One column → one admin field. Everything a list cell, a detail row, a form input, a filter and
// an MCP tool schema need is decided here, once, from the column's facts and the app's override —
// and a sealed column is derived by a function of its own, whose every read flag is false.

import type { AdminColumnFacts } from './entity-columns';
import {
  type AdminField,
  type AdminFieldType,
  type AdminWidget,
  fieldTypeFromColumn,
  filterable,
  filterKindFor,
  listable,
  searchable,
  sortable,
  widgetFor,
} from './fields';
import type { AdminEntity } from './registry';

export interface AdminFieldOverride {
  readonly type?: AdminFieldType;
  readonly widget?: AdminWidget;
  readonly labelKey?: string;
  /** Out of every surface: list, detail, form, MCP schema. */
  readonly hidden?: boolean;
  readonly inList?: boolean;
  readonly readOnly?: boolean;
  readonly required?: boolean;
  readonly sensitive?: boolean;
  readonly filterable?: boolean;
  readonly sortable?: boolean;
  readonly searchable?: boolean;
  readonly currency?: string;
  readonly values?: readonly string[];
  /** The resource a foreign key points at, when the entity's own `references()` is not it. */
  readonly relation?: { readonly entity: string };
  /** i18n key of the hint under the form control, rendered through `t()`. */
  readonly hintKey?: string;
  /** The field is a form input on one side only: set at `create`, or editable from `update`. */
  readonly on?: 'create' | 'update';
}

export function deriveField(
  entity: AdminEntity,
  column: AdminColumnFacts,
  override: AdminFieldOverride | undefined,
): AdminField {
  const name = column.name;
  const type = override?.type ?? fieldTypeFromColumn(entity.$name, name, column);
  const widget = override?.widget ?? widgetFor(type);
  const generated = column.generated || column.primaryKey;
  // `sensitive` is the ADMIN's word for "keep this out of the list, the form and every audit
  // diff" (an email, a phone number) and it has no entity source, so it is declared here or it is
  // absent. A column the entity itself seals (`.sealed()`) never reaches this function at all —
  // `secretField` below derives it. A currency belongs to the value rather than the column.
  const sensitive = override?.sensitive ?? false;
  const currency = override?.currency;
  const values = override?.values ?? column.values;
  const relation =
    override?.relation ??
    (column.references === undefined ? undefined : { entity: column.references.entity });
  // The handle scopes every read and write by this column, so the acting actor's tenant is the
  // only value it can hold: it is not an input, not a list column, and not a filter.
  const tenant = entity.$tenantColumn === name;
  const filterKind = tenant ? undefined : filterKindFor(type, column);

  return {
    entity: entity.$name,
    name,
    type,
    widget,
    labelKey: override?.labelKey ?? `admin.${entity.$name}.field.${name}`,
    required: override?.required ?? (!column.nullable && !generated && !tenant),
    readOnly: override?.readOnly ?? (generated || tenant),
    sensitive,
    inList: override?.inList ?? (listable(type) && !sensitive && !tenant),
    filterable: filterKind !== undefined && (override?.filterable ?? filterable(type, column)),
    ...(filterKind === undefined ? {} : { filterKind }),
    sortable: override?.sortable ?? sortable(type, column),
    // Generated columns are excluded from search: an id is found by exact lookup, and a
    // `contains` over a uuid column is a scan that returns nothing useful.
    searchable: override?.searchable ?? (searchable(type, column) && !sensitive && !generated),
    ...(values === undefined ? {} : { values }),
    ...(currency === undefined ? {} : { currency }),
    ...(relation === undefined ? {} : { relation }),
    ...(override?.hintKey === undefined ? {} : { hintKey: override.hintKey }),
    ...(override?.on === undefined ? {} : { on: override.on }),
  };
}

/**
 * A sealed column as the form sees it: a password-style input, required only on create, and
 * nothing else. Every read flag is false by construction, not by an override an app could flip.
 */
export function secretField(
  entity: AdminEntity,
  column: AdminColumnFacts,
  override: AdminFieldOverride | undefined,
): AdminField {
  return {
    entity: entity.$name,
    name: column.name,
    type: 'secret',
    widget: 'secret-input',
    labelKey: override?.labelKey ?? `admin.${entity.$name}.field.${column.name}`,
    required: !column.nullable,
    readOnly: false,
    sensitive: true,
    inList: false,
    filterable: false,
    sortable: false,
    searchable: false,
    ...(override?.hintKey === undefined ? {} : { hintKey: override.hintKey }),
    ...(override?.on === undefined ? {} : { on: override.on }),
  };
}
