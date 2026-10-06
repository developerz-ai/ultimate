// Entity registry → a working CRUD resource, with nothing configured. Columns become
// fields, indexed columns become filters, text columns become search, `createdAt` becomes
// the default sort, i18n keys become labels. Every derived decision is overridable per
// field, but the zero-config result is the one the generator emits and the one the docs show.

import { finiteCount } from '@ultimat3/core';
import { type AdminColumnFacts, adminColumnsOf, adminSealedColumnsOf } from './entity-columns';
import {
  AdminEntityUnknownError,
  AdminFieldUnsupportedError,
  AdminPolicyMissingError,
  AdminRepoUnboundError,
} from './errors';
import type { AdminField } from './fields';
import { ADMIN_OPERATIONS, type AdminOperation } from './permissions';
import type { AdminAction, AdminEntity, AdminRepo, AdminRow, AdminSort } from './registry';
import { type AdminFieldOverride, deriveField, secretField } from './resource-fields';
import {
  type AdminFormGroupOptions,
  type AdminSection,
  type AdminSectionOptions,
  layoutOf,
} from './resource-layout';
import {
  type AdminComputedColumn,
  type AdminComputedColumnOptions,
  type AdminRowScope,
  type AdminScope,
  type AdminScopeOptions,
  computedColumnsOf,
  rowScopeOf,
  scopesOf,
} from './resource-list';

/** Six columns is what fits a laptop viewport without horizontal scroll. */
const MAX_LIST_FIELDS = 6;
const DEFAULT_PAGE_SIZE = 25;
const LABEL_CANDIDATES = ['name', 'title', 'slug', 'label', 'email'] as const;
const SORT_CANDIDATES = ['createdAt', 'created_at', 'updatedAt', 'updated_at'] as const;

export interface AdminResourceOptions<Row extends AdminRow = AdminRow> {
  readonly repo?: AdminRepo<Row>;
  readonly path?: string;
  /**
   * The noun this resource's permissions are named after — `<permission>:read|write|delete`.
   * Default: the entity's name. Several resources that are one subject to an operator share one
   * (the jobs screens are all `job:read`), so a role map grants a subject once, not per table.
   */
  readonly permission?: string;
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
  /**
   * Computed list columns, drawn after `listFields` in declaration order:
   * `age: { value: (row) => row.createdAt, render: 'relative-time' }`. `render` is one of the six
   * built-in renderers or a component. A name that is also an entity column is refused.
   */
  readonly columns?: Readonly<Record<string, AdminComputedColumnOptions<Row>>>;
  /**
   * Named predicates, drawn as tabs: `open: { where: [...] }`, `mine: { where: (actor) => [...] }`.
   * At most one `default: true`; `count: true` is one extra query per tab that asks for it.
   */
  readonly scopes?: Readonly<Record<string, AdminScopeOptions>>;
  /**
   * Show this resource's row count on the `/admin` home. Opt-in, as a scope tab's `count` is: the
   * figure is one full `count()` over the actor's rows on EVERY visit to the front page, so on a
   * big table any operator reloading it is a load generator. Absent: no tile, the resource is still
   * listed in the permission matrix.
   */
  readonly count?: boolean;
  /**
   * The rows this ACTOR may see at all. Applied to every read of the resource — list, search,
   * detail, lookup, labels, MCP — so it is the one place a second audience is declared.
   */
  readonly rows?: AdminRowScope;
  /**
   * The detail page, as titled groups of fields. A field named in none falls into a default
   * section drawn last, so a column added to the entity is never hidden by this list.
   */
  readonly sections?: readonly AdminSectionOptions[];
  /** The same arrangement for the create and edit form. Independent of `sections`. */
  readonly formGroups?: readonly AdminFormGroupOptions[];
  /**
   * `hasMany` relations of the entity, by name — `['comments']` — drawn on the detail page as the
   * RELATED resource's own list (its columns, its row scope, its policy) filtered to this row.
   * The names are `@ultimat3/entity`'s: the one a preload names.
   */
  readonly related?: readonly string[];
  readonly defaultSort?: AdminSort;
  readonly pageSize?: number;
  readonly operations?: readonly AdminOperation[];
  readonly actions?: readonly AdminAction[];
}

export interface AdminResource<Row extends AdminRow = AdminRow> {
  readonly name: string;
  /**
   * Mount-relative, e.g. `/posts` — the layout composes it with `AdminApp.basePath`, so this is
   * never the URL on its own.
   *
   * Defaults to the entity's `$name` VERBATIM. It used to be `pluralize($name)`, which is why the
   * reference app's dashboard served `/orgses`, `/postses` and `/commentses`: every entity in both
   * tracked apps is already named plural (19 of 19), so the heuristic ran a second time on a word
   * that had already had it. Which plural a name takes is an app's convention and not a mechanism
   * the framework can own (axiom 8) — `path:` is how an app spells its own.
   */
  readonly path: string;
  /** The permission noun — `<permission>:read` lists it. The entity's name unless declared. */
  readonly permission: string;
  readonly titleKey: string;
  readonly group: string;
  readonly idField: string;
  /** The column that names a row in a reference widget, a search hit, or a breadcrumb. */
  readonly labelField: string;
  readonly entity: AdminEntity;
  readonly fields: readonly AdminField[];
  readonly listFields: readonly AdminField[];
  readonly formFields: readonly AdminField[];
  /**
   * The entity's `.sealed()` columns, as WRITE-ONLY inputs: a form posts them, nothing reads them.
   * Deliberately a list of its own and in none of the others — `fields`, `listFields`,
   * `formFields`, `filters` and `searchFields` are all read back by column name somewhere, and a
   * sealed property answers that read with its plaintext.
   */
  readonly secretFields: readonly AdminField[];
  /**
   * The label field first — a list's search box is its `contains` filter — then every field the
   * derivation offers. What a URL's `f.<field>` may name, and nothing else.
   */
  readonly filters: readonly AdminField[];
  readonly searchFields: readonly AdminField[];
  /** Computed list columns, in declaration order. */
  readonly columns: readonly AdminComputedColumn[];
  /** Declared scopes, in tab order. Empty for a resource that declares none. */
  readonly scopes: readonly AdminScope[];
  /** The `/admin` home counts this resource — `count: true` declared. */
  readonly count: boolean;
  /** `rows`, validated per call. Absent for a resource every permitted actor sees whole. */
  readonly rowScope?: AdminRowScope;
  /** The detail page's groups. Always at least one: undeclared fields have a default section. */
  readonly sections: readonly AdminSection[];
  /** The form's groups, over `formFields` and `secretFields` both. */
  readonly formGroups: readonly AdminSection[];
  /** Declared `related` relation names, in order. `related.ts` resolves each against the admin. */
  readonly related: readonly string[];
  readonly defaultSort: AdminSort;
  readonly pageSize: number;
  readonly operations: readonly AdminOperation[];
  readonly actions: readonly AdminAction[];
  readonly repo?: AdminRepo<Row>;
  field(name: string): AdminField;
}

/**
 * The declared key wins — but a composite one is refused outright, never silently reduced to
 * its first member: a route id and an `AdminRepo` id both carry exactly one string, so two rows
 * sharing only that first member would become indistinguishable for read, update and delete.
 */
function idFieldOf(entity: AdminEntity, columns: readonly AdminColumnFacts[]): string {
  if (entity.$primaryKey.length > 1) {
    throw new AdminFieldUnsupportedError({
      entity: entity.$name,
      field: entity.$primaryKey.join(','),
      cause:
        'has a composite primary key; the admin addresses a row by a single id and cannot yet carry every key part',
      fix: 'give the entity a single-column id, or wait for composite-key support in AdminRepo',
    });
  }
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
          // `x db gen` and NOT `x g migration`: there is no `migration` generator, and the fix
          // line an operator pastes has to be a command the CLI actually dispatches.
          fix: `remove "${name}" from listFields, or add the column with x db gen "add ${name} to ${entityName}"`,
        });
      }
      return field;
    });
  }
  const label = fields.filter((field) => field.name === labelField);
  const rest = fields.filter((field) => field.inList && field.name !== labelField);
  return [...label, ...rest].slice(0, MAX_LIST_FIELDS);
}

/**
 * The label first, whether or not it is indexed: a list's search box IS the label's `contains`
 * filter, and a list an operator cannot search by name is the one they leave for a SQL console.
 * Only a text label qualifies — a `contains` over a uuid is a database error, not an empty result.
 */
function filtersOf(fields: readonly AdminField[], labelField: string): readonly AdminField[] {
  const label = fields.filter(
    (field) => field.name === labelField && field.filterKind === 'text' && !field.sensitive,
  );
  return [...label, ...fields.filter((field) => field.filterable && !label.includes(field))];
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
  const declared = { name: entity.$name, entity };
  const rowScope = rowScopeOf(declared, opts.rows);

  const formFields = fields.filter((field) => !field.readOnly && !field.sensitive);
  const secretFields = adminSealedColumnsOf(entity)
    .filter((column) => overrides[column.name]?.hidden !== true)
    .map((column) => secretField(entity, column, overrides[column.name]));

  const resource: AdminResource<Row> = {
    name: entity.$name,
    path: opts.path ?? `/${entity.$name}`,
    permission: opts.permission ?? entity.$name,
    titleKey: opts.titleKey ?? `admin.${entity.$name}.title`,
    group: opts.group ?? 'admin.group.data',
    idField,
    labelField,
    entity,
    fields,
    listFields: pickListFields(fields, labelField, opts.listFields, entity.$name),
    formFields,
    secretFields,
    filters: filtersOf(fields, labelField),
    searchFields: fields.filter((field) => field.searchable),
    columns: computedColumnsOf(declared, opts.columns),
    scopes: scopesOf(declared, opts.scopes, opts.repo),
    count: opts.count === true,
    ...(rowScope === undefined ? {} : { rowScope }),
    sections: layoutOf(
      {
        entity: entity.$name,
        option: 'sections',
        // What the detail page draws: every field but a `sensitive` one. A sealed column is in no
        // list a reader iterates, so it cannot be named here either.
        fields: fields.filter((field) => !field.sensitive),
        excluded:
          'is not a field the detail page draws (hidden, sensitive, sealed, or not a column)',
      },
      opts.sections,
    ),
    formGroups: layoutOf(
      {
        entity: entity.$name,
        option: 'formGroups',
        fields: [...formFields, ...secretFields],
        excluded: 'is not a form input (read-only, generated, sensitive, hidden, or not a column)',
      },
      opts.formGroups,
    ),
    related: opts.related ?? [],
    defaultSort: opts.defaultSort ?? defaultSortOf(fields, idField),
    // Refused here rather than at the first listing, because `pagination.ts` clamps with
    // `Math.max(1, Math.min(x, 200))` and neither of those validates: a `NaN` survives both, so
    // `fetched.length > NaN` is false, the page is never trimmed, `hasMore` is false and the repo
    // is asked for `limit: NaN`. At least 1 — a page with no rows on it is not a page.
    pageSize: finiteCount('adminResource', 'pageSize', opts.pageSize ?? DEFAULT_PAGE_SIZE, 1),
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
    throw new AdminRepoUnboundError({ entity: resource.name, handles: [] });
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
