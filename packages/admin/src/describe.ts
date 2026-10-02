// One admin, as plain data: its resources with the filters, sorts and scopes each list answers,
// whether a row scope narrows it, how its detail and form are arranged, the related lists and the
// actions it offers — and its routes with the permissions that gate them.
// JSON-safe and deterministic — what `x manifest` records, read off `AdminApp.describe()` by a
// tier that may not import this package.

import type { AdminRoute } from './admin';
import { batchPlan } from './batch';
import type { AdminAction } from './registry';
import type { AdminResource } from './resource';
import type { AdminSection } from './resource-layout';

export interface AdminScopeDescription {
  readonly name: string;
  readonly default: boolean;
  /** The tab reads a count — one extra query per list page. */
  readonly count: boolean;
}

/** One titled group of a detail page or a form. `null`: the untitled default group. */
export interface AdminSectionDescription {
  readonly title: string | null;
  readonly fields: readonly string[];
}

/** One action as an agent, the batch bar and a reviewer need to know it. */
export interface AdminActionDescription {
  readonly name: string;
  readonly permission: string;
  readonly destructive: boolean;
  /** It declares an input schema: its button is a form. */
  readonly input: boolean;
  /** It declares `when`: it applies to some rows only. */
  readonly when: boolean;
  /** It is in the batch bar and its MCP tool takes `ids`. */
  readonly batch: boolean;
  /** Rows a batch runs inline before it is queued as `admin.batch` jobs. `null`: always inline. */
  readonly threshold: number | null;
}

export interface AdminResourceDescription {
  readonly entity: string;
  /** Mount-relative: `/posts`. */
  readonly path: string;
  /** The fields a list URL's `f.<field>` and the MCP list tool's `where` may name. */
  readonly filters: readonly string[];
  /** The fields `?sort=` may name. */
  readonly sorts: readonly string[];
  readonly scopes: readonly AdminScopeDescription[];
  /** `rows` is declared: every read of the resource is narrowed per actor. */
  readonly rowScoped: boolean;
  readonly sections: readonly AdminSectionDescription[];
  readonly formGroups: readonly AdminSectionDescription[];
  /** The `hasMany` relations drawn on the detail page, by name. */
  readonly related: readonly string[];
  /** Declaration order — the order the buttons are drawn in. */
  readonly actions: readonly AdminActionDescription[];
}

export interface AdminRouteDescription {
  readonly url: string;
  readonly view: string;
  /** The resource a generated screen belongs to; `null` for the dashboard, a page, a system screen. */
  readonly entity: string | null;
  readonly permissions: readonly string[];
}

export interface AdminDescription {
  readonly basePath: string;
  /** Which audit log the admin writes: `memory` forgets at a restart, `postgres` is the record. */
  readonly audit: string;
  readonly resources: readonly AdminResourceDescription[];
  readonly routes: readonly AdminRouteDescription[];
}

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const sectionOf = (section: AdminSection): AdminSectionDescription => ({
  title: section.titleKey,
  fields: section.fields.map((field) => field.name),
});

const actionOf = (action: AdminAction): AdminActionDescription => ({
  name: action.name,
  permission: action.permission,
  destructive: action.destructive === true,
  input: action.input !== undefined,
  when: action.when !== undefined,
  batch: action.batch !== undefined,
  threshold: batchPlan(action)?.threshold ?? null,
});

/** Sorted by name and by URL, so two boots of one app describe it in the same bytes. */
export function describeAdmin(
  basePath: string,
  resources: readonly AdminResource[],
  routes: readonly AdminRoute[],
  audit: string,
): AdminDescription {
  return {
    basePath,
    audit,
    resources: resources
      .map((resource) => ({
        entity: resource.name,
        path: resource.path,
        // Declaration order for both: it is the order the filter bar and the tabs are drawn in.
        filters: resource.filters.map((field) => field.name),
        sorts: resource.fields.filter((field) => field.sortable).map((field) => field.name),
        scopes: resource.scopes.map((scope) => ({
          name: scope.name,
          default: scope.default,
          count: scope.count,
        })),
        rowScoped: resource.rowScope !== undefined,
        sections: resource.sections.map(sectionOf),
        formGroups: resource.formGroups.map(sectionOf),
        related: [...resource.related],
        actions: resource.actions.map(actionOf),
      }))
      .sort((a, b) => byCodeUnit(a.entity, b.entity)),
    routes: routes
      .map((route) => ({
        url: route.path,
        view: route.view,
        entity: route.entity,
        permissions: [...route.permissions],
      }))
      .sort((a, b) => byCodeUnit(a.url, b.url)),
  };
}
