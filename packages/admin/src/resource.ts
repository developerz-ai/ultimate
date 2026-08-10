// Entity registry → a working CRUD resource, with nothing configured. Columns become
// fields, indexed columns become filters, text columns become search, `createdAt` becomes
// the default sort, i18n keys become labels. Every derived decision is overridable per
// field, but the zero-config result is the one the generator emits and the one the docs show.

import { type AdminColumnFacts, adminColumnsOf } from './entity-columns';
import {
  AdminEntityUnknownError,
  AdminFieldUnsupportedError,
  AdminPolicyMissingError,
} from './errors';
import {
  type AdminField,
  type AdminFieldType,
  type AdminWidget,
  fieldTypeFromColumn,
  filterable,
  listable,
  searchable,
  sortable,
  widgetFor,
} from './fields';
import { ADMIN_OPERATIONS, type AdminOperation } from './permissions';
import type { AdminAction, AdminEntity, AdminRepo, AdminRow, AdminSort } from './registry';

/** Six columns is what fits a laptop viewport without horizontal scroll. */
const MAX_LIST_FIELDS = 6;
const DEFAULT_PAGE_SIZE = 25;
const LABEL_CANDIDATES = ['name', 'title', 'slug', 'label', 'email'] as const;
const SORT_CANDIDATES = ['createdAt', 'created_at', 'updatedAt', 'updated_at'] as const;

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
  readonly relation?: { readonly entity: string; readonly labelField?: string };
}

export interface AdminResourceOptions<Row extends AdminRow = AdminRow> {
  readonly repo?: AdminRepo<Row>;
  readonly path?: string;
  readonly titleKey?: string;
  readonly group?: string;
  /**
   * The field that names a row in a reference widget, a search hit, a breadcrumb. An entity
   * declares no such thing, so this is the only way to say it out loud; omitted, it is derived
   * from the conventional names below.
   */
  readonly labelField?: string;
  readonly fields?: Readonly<Record<string, AdminFieldOverride>>;
  /** Explicit list columns, in order. Omit to let the derivation pick. */
  readonly listFields?: readonly string[];
  readonly defaultSort?: AdminSort;
  readonly pageSize?: number;
  readonly operations?: readonly AdminOperation[];
  readonly actions?: readonly AdminAction[];
}

export interface AdminResource<Row extends AdminRow = AdminRow> {
  readonly name: string;
  /** Mount-relative, e.g. `/posts`. */
  readonly path: string;
  readonly titleKey: string;
  readonly group: string;
  readonly idField: string;
  /** The column that names a row in a reference widget, a search hit, or a breadcrumb. */
  readonly labelField: string;
  readonly entity: AdminEntity;
  readonly fields: readonly AdminField[];
  readonly listFields: readonly AdminField[];
  readonly formFields: readonly AdminField[];
  readonly filters: readonly AdminField[];
  readonly searchFields: readonly AdminField[];
  readonly defaultSort: AdminSort;
  readonly pageSize: number;
  readonly operations: readonly AdminOperation[];
  readonly actions: readonly AdminAction[];
  readonly repo?: AdminRepo<Row>;
  field(name: string): AdminField;
}

const pluralize = (name: string): string => {
  if (/[sxz]$/.test(name) || /(ch|sh)$/.test(name)) return `${name}es`;
  if (/[^aeiou]y$/.test(name)) return `${name.slice(0, -1)}ies`;
  return `${name}s`;
};

function deriveField(
  entity: AdminEntity,
  column: AdminColumnFacts,
  override: AdminFieldOverride | undefined,
): AdminField {
  const name = column.name;
  const type = override?.type ?? fieldTypeFromColumn(entity.$name, name, column);
  const widget = override?.widget ?? widgetFor(type);
  const generated = column.generated || column.primaryKey;
  // An entity has no notion of a secret column, and a currency belongs to the value rather
  // than the column, so both are admin-side declarations or they are absent. Never guessed.
  const sensitive = override?.sensitive ?? false;
  const currency = override?.currency;
  const values = override?.values ?? column.values;
  const relation =
    override?.relation ??
    // The FK's value IS the target column's value, so that column is the honest default label.
    (column.references === undefined
      ? undefined
      : { entity: column.references.entity, labelField: column.references.column });

  return {
    entity: entity.$name,
    name,
    type,
    widget,
    labelKey: override?.labelKey ?? `admin.${entity.$name}.field.${name}`,
    required: override?.required ?? (!column.nullable && !generated),
    readOnly: override?.readOnly ?? generated,
    sensitive,
    inList: override?.inList ?? (listable(type) && !sensitive),
    filterable: override?.filterable ?? filterable(type, column),
    sortable: override?.sortable ?? sortable(type, column),
    // Generated columns are excluded from search: an id is found by exact lookup, and a
    // `contains` over a uuid column is a scan that returns nothing useful.
    searchable: override?.searchable ?? (searchable(type) && !sensitive && !generated),
    ...(values === undefined ? {} : { values }),
    ...(currency === undefined ? {} : { currency }),
    ...(relation === undefined ? {} : { relation }),
  };
}

/**
 * The declared key wins, composite included: the admin addresses a row by the first member,
 * which is the only column a single-id URL and an `AdminRepo` can carry.
 */
function idFieldOf(entity: AdminEntity, columns: readonly AdminColumnFacts[]): string {
  const declared = entity.$primaryKey[0] ?? columns.find((column) => column.primaryKey)?.name;
  if (declared !== undefined) return declared;
  if (columns.some((column) => column.name === 'id')) return 'id';
  throw new AdminEntityUnknownError({
    entity: entity.$name,
    known: columns.map((column) => column.name),
    cause: `entity "${entity.$name}" has no primary key and no "id" column, so the admin cannot address a row`,
  });
}

function labelFieldOf(
  entity: AdminEntity,
  fields: readonly AdminField[],
  idField: string,
  declared: string | undefined,
): string {
  if (declared !== undefined) {
    // A label nobody can read is a table of ids and a search that returns them: say so here,
    // not by silently falling back to the id column three surfaces later.
    if (!fields.some((field) => field.name === declared)) {
      throw new AdminFieldUnsupportedError({
        entity: entity.$name,
        field: declared,
        cause: 'named as labelField but not a visible field of this resource',
        fix: `adminResource(${entity.$name}, { labelField: '${idField}' })   # a field that is not hidden`,
      });
    }
    return declared;
  }
  for (const candidate of LABEL_CANDIDATES) {
    if (fields.some((field) => field.name === candidate)) return candidate;
  }
  const firstText = fields.find(
    (field) => (field.type === 'text' || field.type === 'textarea') && field.name !== idField,
  );
  return firstText?.name ?? idField;
}

function defaultSortOf(fields: readonly AdminField[], idField: string): AdminSort {
  for (const candidate of SORT_CANDIDATES) {
    const field = fields.find((f) => f.name === candidate && f.sortable);
    if (field !== undefined) return { field: field.name, direction: 'desc' };
  }
  return { field: idField, direction: 'desc' };
}

function pickListFields(
  fields: readonly AdminField[],
  labelField: string,
  explicit: readonly string[] | undefined,
  entityName: string,
): readonly AdminField[] {
  if (explicit !== undefined) {
    return explicit.map((name) => {
      const field = fields.find((f) => f.name === name);
      if (field === undefined) {
        throw new AdminFieldUnsupportedError({
          entity: entityName,
          field: name,
          cause: 'listed in listFields but not a column of the entity',
          fix: `remove "${name}" from listFields, or add the column with x g migration`,
        });
      }
      return field;
    });
  }
  const label = fields.filter((field) => field.name === labelField);
  const rest = fields.filter((field) => field.inList && field.name !== labelField);
  return [...label, ...rest].slice(0, MAX_LIST_FIELDS);
}

function assertActionsHavePolicies(actions: readonly AdminAction[]): void {
  for (const action of actions) {
    // Widened because the registry is JSON at the boundary: a hand-written action object
    // that forgot `policy` reaches us with the field absent, not just empty.
    const permission: string | undefined = action.permission;
    if (permission === undefined || permission.trim() === '') {
      throw new AdminPolicyMissingError({ subject: action.name, kind: 'action' });
    }
  }
}

/** Derive list / detail / create / edit / delete from one registered entity. */
export function adminResource<Row extends AdminRow = AdminRow>(
  entity: AdminEntity,
  opts: AdminResourceOptions<Row> = {},
): AdminResource<Row> {
  const columns = adminColumnsOf(entity);
  if (columns.length === 0) {
    throw new AdminEntityUnknownError({
      entity: entity.$name,
      known: [],
      cause: `entity "${entity.$name}" declares no columns`,
    });
  }

  const idField = idFieldOf(entity, columns);
  const overrides = opts.fields ?? {};
  const fields = columns
    .filter((column) => overrides[column.name]?.hidden !== true)
    .map((column) => deriveField(entity, column, overrides[column.name]));

  const labelField = labelFieldOf(entity, fields, idField, opts.labelField);
  const actions = opts.actions ?? [];
  assertActionsHavePolicies(actions);

  const resource: AdminResource<Row> = {
    name: entity.$name,
    path: opts.path ?? `/${pluralize(entity.$name)}`,
    titleKey: opts.titleKey ?? `admin.${entity.$name}.title`,
    group: opts.group ?? 'admin.group.data',
    idField,
    labelField,
    entity,
    fields,
    listFields: pickListFields(fields, labelField, opts.listFields, entity.$name),
    formFields: fields.filter((field) => !field.readOnly && !field.sensitive),
    filters: fields.filter((field) => field.filterable),
    searchFields: fields.filter((field) => field.searchable),
    defaultSort: opts.defaultSort ?? defaultSortOf(fields, idField),
    pageSize: opts.pageSize ?? DEFAULT_PAGE_SIZE,
    operations: opts.operations ?? ADMIN_OPERATIONS,
    actions,
    ...(opts.repo === undefined ? {} : { repo: opts.repo }),
    field(name: string): AdminField {
      const field = fields.find((f) => f.name === name);
      if (field === undefined) {
        throw new AdminFieldUnsupportedError({
          entity: entity.$name,
          field: name,
          cause: 'not a field of this resource (hidden, or not a column)',
          fix: `x manifest   # then check adminResource(${entity.$name}).fields`,
        });
      }
      return field;
    },
  };
  return resource;
}

/** The bound repo, or the one error that says which resource forgot it. */
export function repoOf<Row extends AdminRow>(resource: AdminResource<Row>): AdminRepo<Row> {
  if (resource.repo === undefined) {
    throw new AdminEntityUnknownError({
      entity: resource.name,
      known: [],
      cause: `resource "${resource.name}" has no repo bound, so the admin cannot read or write rows`,
    });
  }
  return resource.repo;
}

/** Look a resource up by entity name. The only place a name→resource miss is reported. */
export function resourceFor<Row extends AdminRow = AdminRow>(
  resources: readonly AdminResource<Row>[],
  name: string,
): AdminResource<Row> {
  const found = resources.find((resource) => resource.name === name);
  if (found === undefined) {
    throw new AdminEntityUnknownError({
      entity: name,
      known: resources.map((resource) => resource.name),
    });
  }
  return found;
}
