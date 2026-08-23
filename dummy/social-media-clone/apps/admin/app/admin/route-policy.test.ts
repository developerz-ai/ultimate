// One admin URL, ONE permission declaration.
//
// `defineAdmin()` builds a route table that already states what every admin URL needs
// (`permissionsForOperation(...)`, packages/admin/src/admin.ts). Until 1.2.0 each page file in
// this app ALSO typed `policy: { permission: 'admin:read' }` into its own `defineRoute`. The two
// happened to agree — which is why nothing caught it — and nothing would have caught them
// disagreeing either: the route table is not the thing the router receives, so the gate that runs
// is the one in the page and the one an operator reads is the one in the table.
//
// These two tests are the seam. The first refuses a typed-in permission anywhere under
// `app/admin/**/page.tsx`; the second proves the gate a page actually declares IS the table's.

import { beforeAll, expect, test } from 'bun:test';
import { adminRouteFor } from '@ultimat3/admin';

// Loaded after `@ultimat3/render/server` has installed its `.tsx` loader, and never statically:
// `admin.ts` statically imports `pages/ops.tsx`. A static import compiles that `.tsx` before
// the plugin exists, so it is cached against `React.createElement` and every later render in
// the process dies with `React is not defined`. The rule is enforced by `apps/admin/static-tsx-
// imports.test.ts`, which explains the whole mechanism.
await import('@ultimat3/render/server');
const { admin } = await import('./admin');

/** A page module, seen through the one field this file judges. */
interface MountedPage {
  readonly config: { readonly policy?: { readonly permission: string } };
}

/**
 * Every file that serves an admin URL, written out rather than imported dynamically: Bun resolves
 * a dynamic specifier at runtime and a typo would read as "no pages to check", which is a green
 * suite over an unchecked surface. The glob below is what keeps this list complete.
 */
const MOUNTS: Readonly<Record<string, () => Promise<MountedPage>>> = {
  'page.tsx': () => import('./page'),
  'jobs/page.tsx': () => import('./jobs/page'),
  'media/page.tsx': () => import('./media/page'),
  'ops/page.tsx': () => import('./ops/page'),
  'posts/page.tsx': () => import('./posts/page'),
  'users/page.tsx': () => import('./users/page'),
};

/** `page.tsx` → `/admin`; `jobs/page.tsx` → `/admin/jobs`. The directory is the URL. */
const urlOf = (file: string): string => {
  const dir = file.slice(0, Math.max(0, file.length - 'page.tsx'.length)).replace(/\/$/, '');
  return dir === '' ? admin.basePath : `${admin.basePath}/${dir}`;
};

const found: string[] = [];
const loaded = new Map<string, MountedPage>();

beforeAll(async () => {
  for await (const file of new Bun.Glob('**/page.tsx').scan({ cwd: import.meta.dir })) {
    found.push(file);
  }
  found.sort();
  for (const [file, load] of Object.entries(MOUNTS)) loaded.set(file, await load());
});

test('the list of admin pages below is complete — a new one cannot skip these checks', () => {
  expect(found).toEqual(Object.keys(MOUNTS).sort());
});

test('no admin page types a permission — the route table is the only place one is written', async () => {
  const offenders: string[] = [];
  for (const file of found) {
    const source = await Bun.file(`${import.meta.dir}/${file}`).text();
    // A quoted string after `permission:` is a second declaration of this URL's authz. A
    // variable is not: that is the table's value, read through `adminRouteFor()`.
    if (/permission:\s*['"`]/.test(source)) offenders.push(file);
  }
  expect(offenders).toEqual([]);
});

test('every admin page declares the gate the admin route table declares, and no other', () => {
  for (const [file, page] of loaded) {
    const url = urlOf(file);
    // Throws `X_ADMIN_PAGE_PATH_INVALID` when the table declares no such URL — a page serving an
    // admin path the admin never built is a screen whose permissions nothing composed.
    const route = adminRouteFor(admin, url);
    expect({ file, permission: page.config.policy?.permission }).toEqual({
      file,
      permission: route.policy.permission,
    });
  }
});

/**
 * A page nobody can find is a page that does not exist. `/admin/jobs` had a file, a route and a
 * gate, and no sidebar entry anywhere — `pages:` builds a nav item for a custom page and the
 * framework's BUILT-IN routes (jobs, audit, search) get none, so serving one from this app means
 * declaring its link here. The dashboard root is the exception: it is the brand link.
 */
test('every admin page this app serves is reachable from the sidebar', () => {
  const items = admin.nav.flatMap((group) => group.items);
  const unreachable = Object.keys(MOUNTS)
    .filter((file) => file !== 'page.tsx')
    .map((file) => urlOf(file).slice(admin.basePath.length))
    .filter((href) => !items.some((item) => item.href === href));
  expect(unreachable).toEqual([]);
});

test('a sidebar link is gated by the permissions of the URL it opens, never a second list', () => {
  for (const item of admin.nav.flatMap((group) => group.items)) {
    // A resource item carries none: its gate is its own `list` operation, applied by `visibleNav`.
    if (item.permissions === undefined) continue;
    const route = adminRouteFor(admin, `${admin.basePath}${item.href}`);
    expect({ href: item.href, permissions: item.permissions }).toEqual({
      href: item.href,
      permissions: route.permissions,
    });
  }
});

test('the gate is the coarse half of the pair the table states — never a permission of its own', () => {
  for (const file of Object.keys(MOUNTS)) {
    const route = adminRouteFor(admin, urlOf(file));
    // `permissions[0]` is the RECEIVED side: it is `string | undefined` under
    // `noUncheckedIndexedAccess`, and only the received side of `toBe` accepts that.
    expect(route.permissions[0]).toBe(route.policy.permission);
  }
});
