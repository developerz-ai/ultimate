// `defineAdmin()` — one call, a working dashboard. It derives a resource per entity, hangs
// each action off the entity it names, builds the nav, and returns the route table plus the
// audit log and authz every surface then shares. Nothing here queries or renders; it wires.

// For its side effect: the admin's stylesheets are claimed for the surface that serves them.
import './stylesheet-scope';
import { ANONYMOUS_ADMIN_ACTOR, requestActor } from './actor';
import { type AuditLog, memoryAuditLog } from './audit';
import type { AdminActor, AdminAuthz } from './authz';
import { batchPlan } from './batch';
import { adminBatchJob } from './batch-job';
import { adminCatalogKeys } from './catalog-keys';
import type { CrudCtx } from './crud';
import { permissionsForOperation } from './crud';
import { type AdminDescription, describeAdmin } from './describe';
import {
  AdminActionDuplicateError,
  AdminFieldUnsupportedError,
  AdminPagePathInvalidError,
  AdminRepoUnboundError,
} from './errors';
import { JOB_PERMISSION_NOUN, JOBS_GROUP, JOBS_PATH, jobsAdmin } from './jobs/job-resources';
import { registerAdminMount } from './mounts';
import { adminNav, type NavGroup, type NavItem, type NavOptions, visibleNav } from './nav';
import { type AdminCustomPage, type AdminPageComponent, pageNavItems, pageRoutes } from './pages';
import { ADMIN_OPERATIONS, type AdminOperation } from './permissions';
import { declareAdminPermissions, roleAuthz } from './policy-bridge';
import type { AdminAction, AdminDb, AdminEntity, AdminRepo, AdminRow } from './registry';
import { relatedOf } from './related';
import { adminRepoFor, adminTablesOf } from './repo-entity';
import {
  type AdminResource,
  type AdminResourceOptions,
  adminResource,
  resourceFor,
} from './resource';
import { LOOKUP_SEGMENT } from './resource-list';
import { mountAdminRoutes } from './route-config';
import { type AdminBranding, adminBranding, type ThemeAttributes, themeAttributes } from './theme';

/** The host app's auth hook: it owns sessions, the admin owns what a session may do. */
export interface AdminAuth {
  actor(request: Request): Promise<AdminActor | null> | AdminActor | null;
  readonly authz: AdminAuthz;
}

export type AdminView =
  | 'list'
  /** A resource read as a TARGET: the picker every filter and input referencing it searches. */
  | 'lookup'
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
  /**
   * The app's `database()` handle, passed once. Every entity's rows are read and written through
   * its own table there — tenancy, soft delete and sealing included — so an app writes no adapter.
   * An entity the handle does not carry needs `resources.<entity>.repo`, or it is
   * `X_ADMIN_REPO_UNBOUND` here, at declaration.
   */
  readonly db?: AdminDb;
  /** Per-entity overrides, keyed by entity name. `repo` replaces the handle's table for one. */
  readonly resources?: Readonly<Record<string, AdminResourceOptions>>;
  /** Registered actions. Each is attached to `action.entity`, or the global toolbar. */
  readonly actions?: readonly AdminAction[];
  /** Screens the generator would never write. Declared here so they are not a second surface. */
  readonly pages?: readonly AdminCustomPage[];
  readonly nav?: NavOptions;
  readonly branding?: Partial<AdminBranding>;
  /**
   * Both halves default. `actor`: the one the HTTP pipeline resolved for this request. `authz`:
   * the app's role map (`roleAuthz()`) — every permission is "does a role this actor holds grant
   * it". Pass `policyAuthz({ policies })` when a rule reads the row or the tenant.
   */
  readonly auth?: Partial<AdminAuth>;
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
  readonly nav: readonly NavGroup[];
  readonly routes: readonly AdminRoute[];
  readonly audit: AuditLog;
  readonly authz: AdminAuthz;
  readonly auth: AdminAuth;
  resource(name: string): AdminResource;
  /** Nav for one actor, with everything they cannot open removed. */
  navFor(ctx: CrudCtx): readonly NavGroup[];
  ctx(input: { readonly actor: AdminActor; readonly requestId: string }): CrudCtx;
  /**
   * The handle for the request in flight: `auth.actor(request)`, with anonymous as a real actor a
   * decision refuses. What every mounted screen and every write is decided against.
   */
  requestCtx(request: Request): Promise<CrudCtx>;
  /**
   * This admin as plain data — resources with their filters, sorts, scopes and row scope, routes
   * with their permissions. What the manifest records; JSON-safe and sorted.
   */
  describe(): AdminDescription;
  /**
   * Every catalog key this declaration derives, sorted and distinct — what the `i18n` step asks
   * each of the app's catalogs for (`catalog-keys.ts`).
   */
  catalogKeys(): readonly string[];
}

const VIEW_OPERATION: Readonly<
  Record<Exclude<AdminView, 'jobs' | 'audit' | 'dashboard' | 'page'>, AdminOperation>
> = {
  list: 'list',
  // A lookup IS a list read of the target — same gate, same row scope, same audit entry.
  lookup: 'list',
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
      permissions: permissionsForOperation(resource.permission, op),
    });
  };

  add('list', base);
  add('lookup', `${base}/${LOOKUP_SEGMENT}`);
  add('create', `${base}/new`);
  add('detail', `${base}/:id`);
  add('edit', `${base}/:id/edit`);
  return routes;
}

/**
 * One URL, one claimant — checked across RESOURCES, which was the last claim on an admin path
 * that nothing verified.
 *
 * `adminRouteFor` resolves by `.find()`, so two resources declaring one `path:` produced eight
 * routes over four paths and the second resource's four screens were simply unreachable: the app
 * booted, the dashboard rendered, and nothing said so. That is the identical argument
 * `assertUniqueActionNames` below makes for a duplicate action name, and the one `pages.ts` makes
 * for a page shadowing a generated route — the same `taken` set, one step earlier.
 *
 * Every generated path is collected, not just the list root: `/posts` and `/posts/:id` are two
 * claims and a resource colliding on either is the same broken route table.
 */
function assertUniqueResourcePaths(basePath: string, resources: readonly AdminResource[]): void {
  const claimed = new Map<string, string>();
  for (const resource of resources) {
    for (const route of resourceRoutes(basePath, resource)) {
      const owner = claimed.get(route.path);
      if (owner !== undefined) {
        throw new AdminPagePathInvalidError({
          subject: 'resource',
          path: route.path,
          cause: `is already claimed by the resource "${owner}", so "${resource.name}" would be unreachable there`,
          fix: `give one of them its own path: resources: { ${resource.name}: { path: '${resource.path}-2' } }`,
        });
      }
      claimed.set(route.path, resource.name);
    }
  }
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

/**
 * The repo one resource reads through: its own `repo:` override, else the entity's table in the
 * app's handle. Neither is refused HERE — a resource with no repo mounts four routes that all fail
 * on the first row they ask for, and nothing would say so until an operator opened one.
 */
function repoFor(
  entity: AdminEntity,
  override: AdminRepo<AdminRow> | undefined,
  tables: ReadonlyMap<string, Parameters<typeof adminRepoFor>[1]>,
): AdminRepo<AdminRow> {
  if (override !== undefined) return override;
  const table = tables.get(entity.$name);
  if (table === undefined) {
    throw new AdminRepoUnboundError({ entity: entity.$name, handles: [...tables.keys()].sort() });
  }
  return adminRepoFor(entity, table);
}

/**
 * A batch action belongs to a resource — the batch bar is a list's — and a declared threshold is a
 * count. An action with a threshold declares the one `admin.batch` job here, at declaration, so a
 * process that loads this admin is a process that can run its queued chunks.
 */
function assertBatchActions(
  resources: readonly AdminResource[],
  declared: readonly AdminAction[],
): void {
  for (const action of declared) {
    if (action.batch !== undefined && action.entity === undefined) {
      // The closest shipped code is a field's, and its cause renders `<entity>.<field>:` — so the
      // two halves name WHERE the option was written, never a column of an entity called "admin".
      throw new AdminFieldUnsupportedError({
        entity: 'defineAdmin',
        field: `actions["${action.name}"].batch`,
        cause:
          "declares batch with no entity: the batch bar is a resource list's, and a global action belongs to none",
        fix: `name the resource the batch runs over — { name: '${action.name}', entity: '<entity>', batch: true } — or drop batch`,
      });
    }
  }
  for (const action of [...resources.flatMap((resource) => resource.actions), ...declared]) {
    if (action.matching !== undefined && action.batch === undefined) {
      throw new AdminFieldUnsupportedError({
        entity: 'defineAdmin',
        field: `actions["${action.name}"].matching`,
        cause:
          'declares matching without batch: "all matching" is an option of the batch bar, and this action is not in it',
        fix: `add batch: true to { name: '${action.name}', … }, or drop matching`,
      });
    }
  }
  for (const action of resources.flatMap((resource) => resource.actions)) {
    if (batchPlan(action) !== null) adminBatchJob();
  }
}

/** The overview's sidebar link, gated on the route's own pair so the link and the page agree. */
const jobsOverviewNavItem = (): NavItem & { readonly group: string } => ({
  key: 'jobs',
  labelKey: 'admin.jobs.title',
  href: JOBS_PATH,
  entity: null,
  permissions: permissionsForOperation(JOB_PERMISSION_NOUN, 'list'),
  group: JOBS_GROUP,
});

/** Derive the whole admin from the registries. */
export function defineAdmin(input: DefineAdminInput): AdminApp {
  const basePath = input.basePath ?? '/admin';
  const branding = adminBranding(input.branding ?? {});
  const audit = input.audit ?? memoryAuditLog();
  // The jobs dashboard is declared for every admin: four resources and their actions, each an
  // ordinary declaration an app could have written — and an app's `resources:` entry for one of
  // them (`x_jobs: { rows }`) overrides it as it would its own.
  const jobs = jobsAdmin(basePath);
  const actions = [...(input.actions ?? []), ...jobs.actions];
  const overrides: Readonly<Record<string, AdminResourceOptions>> = {
    ...jobs.resources,
    ...Object.fromEntries(
      Object.entries(input.resources ?? {}).map(([name, own]) => [
        name,
        { ...(Object.hasOwn(jobs.resources, name) ? jobs.resources[name] : {}), ...own },
      ]),
    ),
  };
  const tables = input.db === undefined ? new Map() : adminTablesOf(input.db);
  const auth: AdminAuth = {
    actor: input.auth?.actor ?? (() => requestActor().actor),
    authz: input.auth?.authz ?? roleAuthz(),
  };

  const resources = [...input.entities, ...jobs.entities].map((entity) => {
    const own = actions.filter((action) => action.entity === entity.$name);
    const opts = Object.hasOwn(overrides, entity.$name) ? overrides[entity.$name] : undefined;
    return adminResource<AdminRow>(entity, {
      ...(opts ?? {}),
      repo: repoFor(entity, opts?.repo, tables),
      actions: [...(opts?.actions ?? []), ...own],
    });
  });

  assertUniqueActionNames(resources, actions);
  // Refused where they are written, not on the first detail page: a `related` name that is not a
  // `hasMany` of the entity, a batch threshold that is not a count.
  for (const resource of resources) relatedOf(resources, resource);
  assertBatchActions(resources, actions);

  const pages = input.pages ?? [];
  const navOptions = input.nav ?? {};
  const extra: readonly (NavItem & { readonly group: string })[] = [
    ...(navOptions.extra ?? []),
    ...pageNavItems(pages),
  ];
  const nav = adminNav(resources, { ...navOptions, extra: [...extra, jobsOverviewNavItem()] });
  assertUniqueResourcePaths(basePath, resources);
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
      path: `${basePath}${JOBS_PATH}`,
      view: 'jobs',
      entity: null,
      titleKey: 'admin.jobs.title',
      permissions: permissionsForOperation(JOB_PERMISSION_NOUN, 'list'),
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

  // Every permission a route or an action names is one the policy layer must be able to hear
  // about, whichever authz decides it: `can()` refuses a name its registry lacks.
  declareAdminPermissions([
    ...routes.flatMap((route) => route.permissions),
    ...resources.flatMap((resource) =>
      ADMIN_OPERATIONS.flatMap((op) => permissionsForOperation(resource.permission, op)),
    ),
    ...[...resources.flatMap((resource) => resource.actions), ...actions].map(
      (action) => action.permission,
    ),
  ]);

  const ctx = ({ actor, requestId }: { actor: AdminActor; requestId: string }): CrudCtx => ({
    actor,
    requestId,
    audit,
    authz: auth.authz,
  });

  const app: AdminApp = {
    basePath,
    branding,
    theme: themeAttributes(branding),
    resources,
    globalActions: actions.filter((action) => action.entity === undefined),
    nav,
    routes,
    audit,
    authz: auth.authz,
    auth,
    resource(name: string): AdminResource {
      return resourceFor(resources, name);
    },
    navFor(crud: CrudCtx): readonly NavGroup[] {
      return visibleNav(nav, resources, crud);
    },
    ctx,
    async requestCtx(request: Request): Promise<CrudCtx> {
      const actor = await auth.actor(request);
      return ctx({ actor: actor ?? ANONYMOUS_ADMIN_ACTOR, requestId: requestActor().requestId });
    },
    describe: () => describeAdmin(basePath, resources, routes, audit.kind),
    catalogKeys: () => adminCatalogKeys(app),
  };
  // In the framework's one route list, as what they are: mounted, each with its permissions.
  mountAdminRoutes(basePath, routes);
  // Declared is mountable: a host serves every admin in this registry under its base path.
  registerAdminMount(app);
  return app;
}
