// The list half of a resource declaration: scopes, the row scope and computed columns — each
// normalised once and validated where it is written, so a list screen, the search, the lookup and
// the MCP tool all read the same three values and none of them re-reads the options.

import type { JSX } from 'solid-js';
import type { AdminActor } from './authz';
import { AdminFieldUnsupportedError, AdminFilterInvalidError } from './errors';
import { declaredFilters } from './list-filters';
import type { AdminEntity, AdminFilter, AdminRepo, AdminRow } from './registry';
import type { WidgetContext } from './widget-value';

/**
 * The path segment a resource's lookup is mounted under: `/admin/<resource>/lookup`. A literal
 * segment outranks `:id`, exactly as `new` does, so no row can be shadowed by it.
 */
export const LOOKUP_SEGMENT = 'lookup';

/** Predicates, or predicates of the acting actor (`mine`, `my team's`). */
export type AdminScopeWhere =
  | readonly AdminFilter[]
  | ((actor: AdminActor) => readonly AdminFilter[]);

export interface AdminScopeOptions {
  readonly where: AdminScopeWhere;
  /** The scope a bare list URL applies. At most one; with none, the bare list is unscoped. */
  readonly default?: boolean;
  /** Show the row count on the tab. Opt-in: a count is a query, on a big table a slow one. */
  readonly count?: boolean;
  /** Omitted: `admin.<entity>.scope.<name>`. */
  readonly labelKey?: string;
}

/** A declared scope, normalised. `where` is checked on every call — it may depend on the actor. */
export interface AdminScope {
  readonly name: string;
  readonly labelKey: string;
  readonly default: boolean;
  readonly count: boolean;
  where(actor: AdminActor): readonly AdminFilter[];
}

/**
 * Which rows of a resource one actor may see at all. One declaration, applied by every read the
 * admin issues for the resource — list, search, detail, lookup, label, the MCP tools — so a second
 * audience is a function of the actor and never a second copy of the resource.
 */
export type AdminRowScope = (actor: AdminActor) => readonly AdminFilter[];

/** The closed set. An app needing a seventh passes a component for that column. */
export const ADMIN_RENDERERS = [
  'badge',
  'relative-time',
  'money',
  'truncate',
  'link',
  'json',
] as const;

export type AdminRenderer = (typeof ADMIN_RENDERERS)[number];

export interface AdminColumnRenderProps<Row extends AdminRow = AdminRow> {
  readonly value: unknown;
  readonly row: Row;
  readonly ctx: WidgetContext;
}

export type AdminColumnComponent<Row extends AdminRow = AdminRow> = (
  props: AdminColumnRenderProps<Row>,
) => JSX.Element;

export interface AdminComputedColumnOptions<Row extends AdminRow = AdminRow> {
  /**
   * The cell's value, from the row. The row it is handed carries no sealed column: a computed
   * column is rendered, and a sealed value is never rendered.
   */
  readonly value: (row: Row) => unknown;
  readonly render: AdminRenderer | AdminColumnComponent<Row>;
  /** Omitted: `admin.<entity>.column.<name>`. */
  readonly labelKey?: string;
}

/**
 * A declared column, normalised — and typed over `AdminRow`, never the app's own `Row`: a resource
 * that carried `(row: Row) => …` would be invariant in `Row`, and every function taking "any
 * resource" would stop accepting one. The narrowing back happens once, in `computedColumnsOf`.
 */
export interface AdminComputedColumn extends AdminComputedColumnOptions<AdminRow> {
  readonly name: string;
  readonly labelKey: string;
}

interface Declared {
  readonly name: string;
  readonly entity: AdminEntity;
}

/** The declared scopes, in declaration order — which is the order the tabs are drawn in. */
export function scopesOf(
  resource: Declared,
  scopes: Readonly<Record<string, AdminScopeOptions>> | undefined,
  repo: AdminRepo<AdminRow> | undefined,
): readonly AdminScope[] {
  const entries = Object.entries(scopes ?? {});
  const names = entries.map(([name]) => name);
  const refuse = (asked: string, cause: string): never => {
    throw new AdminFilterInvalidError({ entity: resource.name, asked, cause, known: names });
  };
  const defaults = entries.filter(([, scope]) => scope.default === true).map(([name]) => name);
  if (defaults.length > 1) {
    refuse(
      `scopes: ${defaults.join(', ')}`,
      'marks more than one scope `default: true`; a bare list URL applies exactly one',
    );
  }
  return entries.map(([name, scope]) => {
    const declaredAs = `scopes.${name}.where`;
    // A tab's count is `AdminRepo.count`, which a hand-written repo may leave out: refused where
    // the scope is declared, rather than drawn as a tab whose number silently never appears.
    if (scope.count === true && repo !== undefined && repo.count === undefined) {
      refuse(
        `scopes.${name}.count`,
        'asks for a count, and the repo this resource reads through has no count()',
      );
    }
    const where = scope.where;
    if (typeof where !== 'function') declaredFilters(resource, where, declaredAs);
    return {
      name,
      labelKey: scope.labelKey ?? `admin.${resource.name}.scope.${name}`,
      default: scope.default === true,
      count: scope.count === true,
      where: (actor) =>
        typeof where === 'function' ? declaredFilters(resource, where(actor), declaredAs) : where,
    };
  });
}

/** `rows`, checked on every call. Absent stays absent: an unscoped resource asks no predicate. */
export function rowScopeOf(
  resource: Declared,
  rows: AdminRowScope | undefined,
): AdminRowScope | undefined {
  if (rows === undefined) return undefined;
  return (actor) => declaredFilters(resource, rows(actor), 'rows');
}

const isRenderer = (value: unknown): value is AdminRenderer =>
  (ADMIN_RENDERERS as readonly unknown[]).includes(value);

/** Declaration order, after the entity's own list fields. */
export function computedColumnsOf<Row extends AdminRow>(
  resource: Declared,
  columns: Readonly<Record<string, AdminComputedColumnOptions<Row>>> | undefined,
): readonly AdminComputedColumn[] {
  return Object.entries(columns ?? {}).map(([name, column]) => {
    if (Object.hasOwn(resource.entity.$columns, name)) {
      throw new AdminFieldUnsupportedError({
        entity: resource.name,
        field: name,
        cause: 'is declared in `columns:` and is also a column of the entity',
        fix: `rename the computed column in resources.${resource.name}.columns — e.g. ${name}Label — or drop it and let the admin render the column itself`,
      });
    }
    if (typeof column.render !== 'function' && !isRenderer(column.render)) {
      throw new AdminFieldUnsupportedError({
        entity: resource.name,
        field: name,
        cause: `names a renderer the admin does not have (it has: ${ADMIN_RENDERERS.join(', ')})`,
        fix: `set resources.${resource.name}.columns.${name}.render to one of those, or pass a component: render: (props) => <YourCell {...props} />`,
      });
    }
    const render = column.render;
    return {
      name,
      labelKey: column.labelKey ?? `admin.${resource.name}.column.${name}`,
      // The rows a resource's list hands these ARE its `Row`s: the declaration's own type is
      // restored here, at the one place the two meet.
      value: (row) => column.value(row as Row),
      render:
        typeof render === 'function'
          ? (props) => render({ ...props, row: props.row as Row })
          : render,
    };
  });
}
