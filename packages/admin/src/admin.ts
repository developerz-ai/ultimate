// `defineAdmin()` — one call, a working dashboard. It derives a resource per entity, hangs
// each action off the entity it names, builds the nav, and returns the route table plus the
// audit log and authz every surface then shares. Nothing here queries or renders; it wires.

import { type AuditLog, memoryAuditLog } from './audit';
import type { AdminActor, AdminAuthz } from './authz';
import type { CrudCtx } from './crud';
import { permissionsForOperation } from './crud';
import { AdminActionDuplicateError } from './errors';
import { adminNav, type NavGroup, type NavItem, type NavOptions, visibleNav } from './nav';
import { type AdminCustomPage, type AdminPageComponent, pageNavItems, pageRoutes } from './pages';
import type { AdminOperation } from './permissions';
import type { AdminAction, AdminEntity, AdminJobSummary, AdminRow } from './registry';
import {
  type AdminResource,
  type AdminResourceOptions,
  adminResource,
  resourceFor,
} from './resource';
import { type AdminBranding, adminBranding, type ThemeAttributes, themeAttributes } from './theme';

/** The host app's auth hook: it owns sessions, the admin owns what a session may do. */
export interface AdminAuth {
  actor(request: Request): Promise<AdminActor | null> | AdminActor | null;
  readonly authz: AdminAuthz;
}

export type AdminView =
  | 'list'
  | 'detail'
  | 'create'
  | 'edit'
  | 'search'
  | 'jobs'
  | 'audit'
  | 'dashboard'
  /** A `pages:` entry: the app's own component, guarded by the frame. */
  | 'page';

/**
 * A route as data. `routes.ts` turns these into `defineRoute()` configs; keeping the table
 * declarative means the MCP surface and the nav read the same paths the router serves.
 */
export interface AdminRoute {
  readonly path: string;
  readonly view: AdminView;
  readonly entity: string | null;
  readonly titleKey: string;
  readonly permissions: readonly string[];
  /**
   * Set only on `view: 'page'`. It is the AUTHOR's component, still unguarded — `routes.ts` is
   * the only thing that may hand it out, and it hands out the wrapped one.
   */
  readonly component?: AdminPageComponent;
}

export interface DefineAdminInput {
  readonly entities: readonly AdminEntity[];
  /** Per-entity overrides and repo binding, keyed by entity name. */
  readonly resources?: Readonly<Record<string, AdminResourceOptions>>;
  /** Registered actions. Each is attached to `action.entity`, or the global toolbar. */
  readonly actions?: readonly AdminAction[];
  readonly jobs?: readonly AdminJobSummary[];
  /** Screens the generator would never write. Declared here so they are not a second surface. */
  readonly pages?: readonly AdminCustomPage[];
  readonly nav?: NavOptions;
  readonly branding?: Partial<AdminBranding>;
  readonly auth: AdminAuth;
  readonly audit?: AuditLog;
  /** Mount point. Every route path is prefixed with it. */
  readonly basePath?: string;
}

export interface AdminApp {
  readonly basePath: string;
  readonly branding: AdminBranding;
  readonly theme: ThemeAttributes;
  readonly resources: readonly AdminResource[];
  /** Actions with no entity: imports, backfills, anything app-wide. */
  readonly globalActions: readonly AdminAction[];
  readonly jobs: readonly AdminJobSummary[];
  readonly nav: readonly NavGroup[];
  readonly routes: readonly AdminRoute[];
  readonly audit: AuditLog;
  readonly authz: AdminAuthz;
  readonly auth: AdminAuth;
  resource(name: string): AdminResource;
  /** Nav for one actor, with everything they cannot open removed. */
  navFor(ctx: CrudCtx): readonly NavGroup[];
  ctx(input: { readonly actor: AdminActor; readonly requestId: string }): CrudCtx;
}

const VIEW_OPERATION: Readonly<
  Record<Exclude<AdminView, 'jobs' | 'audit' | 'dashboard' | 'page'>, AdminOperation>
> = {
  list: 'list',
  detail: 'detail',
  create: 'create',
  edit: 'update',
  search: 'search',
};

function resourceRoutes(basePath: string, resource: AdminResource): readonly AdminRoute[] {
  const base = `${basePath}${resource.path}`;
  const routes: AdminRoute[] = [];
  const add = (
    view: Exclude<AdminView, 'jobs' | 'audit' | 'dashboard' | 'page'>,
    path: string,
  ): void => {
    const op = VIEW_OPERATION[view];
    if (!resource.operations.includes(op)) return;
    routes.push({
      path,
      view,
      entity: resource.name,
      titleKey: resource.titleKey,
      permissions: permissionsForOperation(resource.name, op),
    });
  };

  add('list', base);
  add('create', `${base}/new`);
  add('detail', `${base}/:id`);
  add('edit', `${base}/:id/edit`);
  return routes;
}

/**
 * One `AdminAction.name`, one handler. The name is the MCP tool name (`admin.action.<name>`), the
 * default label key (`admin.action.<name>`) AND the key `callAdminTool` resolves a handler by, so
 * two actions sharing it dispatch to whichever `.find()` reached first — a call that succeeds
 * against the wrong action and reports nothing. Refused here rather than in `adminMcp()`, because
 * an app that renders the dashboard and never wires MCP has the same two broken label keys and
 * the same ambiguous dispatch.
 *
 * Identity, not name, is what "already seen" means: `defineAdmin` attaches `input.actions` to the
 * entity each one names AND appends `resources[<entity>].actions`, so an author who spelled the
 * same object in both meant one action, not two.
 */
function assertUniqueActionNames(
  resources: readonly AdminResource[],
  declared: readonly AdminAction[],
): void {
  const seen = new Map<string, { readonly action: AdminAction; readonly entities: string[] }>();
  // `declared` is every action the caller passed, not just the global ones: an action naming an
  // entity that is not in `entities` reaches neither list, and its name still has to be unique.
  for (const action of [...resources.flatMap((resource) => resource.actions), ...declared]) {
    const found = seen.get(action.name);
    if (found === undefined) {
      seen.set(action.name, { action, entities: [action.entity ?? 'the global toolbar'] });
      continue;
    }
    if (found.action === action) continue;
    found.entities.push(action.entity ?? 'the global toolbar');
    throw new AdminActionDuplicateError({ name: action.name, entities: found.entities });
  }
}

/** Derive the whole admin from the registries. */
export function defineAdmin(input: DefineAdminInput): AdminApp {
  const basePath = input.basePath ?? '/admin';
  const branding = adminBranding(input.branding ?? {});
  const audit = input.audit ?? memoryAuditLog();
  const actions = input.actions ?? [];
  const overrides = input.resources ?? {};

  const resources = input.entities.map((entity) => {
    const own = actions.filter((action) => action.entity === entity.$name);
    const opts = overrides[entity.$name];
    return adminResource<AdminRow>(entity, {
      ...(opts ?? {}),
      actions: [...(opts?.actions ?? []), ...own],
    });
  });

  assertUniqueActionNames(resources, actions);

  const pages = input.pages ?? [];
  const navOptions = input.nav ?? {};
  const extra: readonly (NavItem & { readonly group: string })[] = [
    ...(navOptions.extra ?? []),
    ...pageNavItems(pages),
  ];
  const nav = adminNav(resources, { ...navOptions, extra });
  const generated: AdminRoute[] = [
    {
      path: basePath,
      view: 'dashboard',
      entity: null,
      titleKey: 'admin.dashboard.title',
      permissions: permissionsForOperation('admin', 'list'),
    },
    {
      path: `${basePath}/search`,
      view: 'search',
      entity: null,
      titleKey: 'admin.search.title',
      permissions: permissionsForOperation('admin', 'search'),
    },
    {
      path: `${basePath}/jobs`,
      view: 'jobs',
      entity: null,
      titleKey: 'admin.jobs.title',
      permissions: permissionsForOperation('job', 'list'),
    },
    {
      path: `${basePath}/audit`,
      view: 'audit',
      entity: null,
      titleKey: 'admin.audit.title',
      permissions: permissionsForOperation('audit', 'list'),
    },
    ...resources.flatMap((resource) => resourceRoutes(basePath, resource)),
  ];

  // Generated first, so a page that would shadow one is refused rather than deciding a race.
  const routes: readonly AdminRoute[] = [
    ...generated,
    ...pageRoutes(
      basePath,
      pages,
      generated.map((route) => route.path),
    ),
  ];

  return {
    basePath,
    branding,
    theme: themeAttributes(branding),
    resources,
    globalActions: actions.filter((action) => action.entity === undefined),
    jobs: input.jobs ?? [],
    nav,
    routes,
    audit,
    authz: input.auth.authz,
    auth: input.auth,
    resource(name: string): AdminResource {
      return resourceFor(resources, name);
    },
    navFor(ctx: CrudCtx): readonly NavGroup[] {
      return visibleNav(nav, resources, ctx);
    },
    ctx({ actor, requestId }): CrudCtx {
      return { actor, requestId, audit, authz: input.auth.authz };
    },
  };
}
