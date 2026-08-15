// The `pages:` seam — a screen no generator would write (a reconciliation fixer, a proxy health
// board, a deploy button), declared as data so it lands in the SAME route table, nav and
// permission pair the generated screens use. Nothing renders here: this file decides a page's
// path and its permissions, so `routes.ts` has exactly one thing to guard.

import type { JSX } from 'solid-js';
import type { AdminRoute } from './admin';
import type { CrudCtx } from './crud';
import { AdminPagePathInvalidError, AdminPageUnguardedError } from './errors';
import type { NavItem } from './nav';
import { ADMIN_READ } from './permissions';

/**
 * What a page component is handed. `ctx` is the same per-request handle every CRUD call takes,
 * and it is REQUIRED BY THE TYPE: a component that cannot be called without a ctx cannot be
 * mounted without the guard that reads one.
 */
export interface AdminPageProps {
  readonly ctx: CrudCtx;
  readonly params: Readonly<Record<string, string>>;
  readonly url: string;
}

/** An ordinary SolidJS component. Async, because a page with data has no `load` seam. */
export type AdminPageComponent = (props: AdminPageProps) => JSX.Element | Promise<JSX.Element>;

export interface AdminCustomPage {
  /** Rooted at the admin's `basePath`: `/ops`, never `/admin/ops` and never `ops`. */
  readonly path: string;
  readonly titleKey: string;
  readonly component: AdminPageComponent;
  /** The nav group key. Omitted means reachable by URL but not linked. */
  readonly navGroup?: string;
  /** At least one. `admin:read` is composed in front of it; empty is X_ADMIN_PAGE_UNGUARDED. */
  readonly permissions: readonly string[];
}

/**
 * The frame's gate, then the page's own — the exact pair `permissionsForOperation()` builds for a
 * resource, so a custom page is decided by the same `decideAll` and cannot invent a third shape.
 */
export function pagePermissions(page: AdminCustomPage): readonly string[] {
  const out: string[] = [ADMIN_READ];
  for (const permission of page.permissions) {
    const trimmed = permission.trim();
    if (trimmed !== '' && !out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}

function assertGuarded(page: AdminCustomPage): void {
  const declared = page.permissions.filter((permission) => permission.trim() !== '');
  if (declared.length === 0) throw new AdminPageUnguardedError({ path: page.path });
}

function assertPath(page: AdminCustomPage, fullPath: string, taken: ReadonlySet<string>): void {
  const refuse = (cause: string, fix: string): never => {
    throw new AdminPagePathInvalidError({ path: page.path, cause, fix });
  };
  if (!page.path.startsWith('/')) {
    refuse('is not rooted', `write path: '/${page.path}' — every page path starts with a slash`);
  }
  if (page.path.length < 2 || page.path.endsWith('/') || page.path.includes('//')) {
    refuse('is not a usable path', "write path: '/ops' — one leading slash, no trailing slash");
  }
  if (taken.has(fullPath)) {
    refuse(
      `is already served by another admin route (${fullPath})`,
      `rename the page, e.g. path: '${page.path}-ops'`,
    );
  }
}

/**
 * Pages as routes. `taken` is every path the generated screens already claimed, so a page that
 * would shadow `/admin/posts` fails at declaration rather than silently winning or losing a
 * router race.
 */
export function pageRoutes(
  basePath: string,
  pages: readonly AdminCustomPage[],
  taken: readonly string[],
): readonly AdminRoute[] {
  const claimed = new Set(taken);
  const routes: AdminRoute[] = [];
  for (const page of pages) {
    assertGuarded(page);
    const fullPath = `${basePath}${page.path}`;
    assertPath(page, fullPath, claimed);
    claimed.add(fullPath);
    routes.push({
      path: fullPath,
      view: 'page',
      entity: null,
      titleKey: page.titleKey,
      permissions: pagePermissions(page),
      component: page.component,
    });
  }
  return routes;
}

/** Nav entries for the pages that asked for one, carrying the permissions that hide them. */
export function pageNavItems(
  pages: readonly AdminCustomPage[],
): readonly (NavItem & { readonly group: string })[] {
  return pages
    .filter((page) => page.navGroup !== undefined)
    .map((page) => ({
      key: page.path,
      labelKey: page.titleKey,
      href: page.path,
      entity: null,
      permissions: pagePermissions(page),
      group: page.navGroup ?? '',
    }));
}
