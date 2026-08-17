// contract — the permissions the ROUTE TABLE names, checked against the permissions the app
// actually declares and grants. `x verify` runs this; a request does not have to.
//
// Three separate bugs shipped green because nothing joined the two halves: `/dashboard` declared
// `dashboard:read` and no module declared that permission (X_PERMISSION_UNKNOWN — a 500 on the page
// every sign-in lands on), `member` was granted the empty list so every other gated page answered
// 403 to a valid session, and both were invisible to unit tests that only ever asked a predicate a
// question. A permission nobody declares and a permission nobody grants are the same failure: a
// route with a gate no actor can pass.

import { resolve } from 'node:path';
import { loadApp } from '@ultimat3/cli';
import { expandRoles, knownPermissions, rolesGranting } from '@ultimat3/policy';
import { routeEntries } from '@ultimat3/render';
import { beforeAll, contractTest, expect } from '@ultimat3/testing';

const ROOT = resolve(import.meta.dir, '../../../..');

/** Every route the running server serves, registered by the framework's own loader. */
const gatedRoutes = (): readonly { path: string; permission: string }[] =>
  routeEntries().flatMap((entry) =>
    entry.config.policy === undefined
      ? []
      : [{ path: entry.path, permission: entry.config.policy.permission }],
  );

beforeAll(async () => {
  // The same import walk `x dev` and `apps/web/server.ts` run at boot, so the registries this
  // file reads are the registries the server reads. A hand-rolled glob here would be a second
  // answer to "what is in this app", and the one that goes stale.
  const loaded = await loadApp(ROOT);
  expect(loaded.findings).toEqual([]);
  // `loadApp` walks this app's whole module graph — ~2.7s alone, and the four contract files
  // that do it run while every other suite competes for the same cores, so the 5000ms bun
  // gives a hook is a coin flip rather than a budget. Booting the app IS the fixture here,
  // so the timeout is what moves. Raised across all four together: they share one cost, and
  // raising the one seen failing only relocates the failure to whichever shard the others
  // land in.
}, 30_000);

contractTest('the app declares gated routes at all — an empty table proves nothing', () => {
  expect(gatedRoutes().length).toBeGreaterThan(0);
});

contractTest('every permission a route declares is declared by a policy module', () => {
  const declared = new Set(knownPermissions());
  const undeclared = gatedRoutes().filter((route) => !declared.has(route.permission));
  // Named, not counted: the failure message has to say which route and which permission, because
  // the fix is a `definePermissions([...])` line in that feature's `policy.ts`.
  expect(undeclared).toEqual([]);
});

contractTest('every permission a route declares is granted to at least one role', () => {
  // A declared permission nobody holds is a gate with no key: the page is reachable by URL, gated
  // by the pipeline, and refused for every account that exists. `member: { grants: [] }` was
  // exactly that, and it passed every test in this app.
  const ungranted = gatedRoutes().filter((route) => rolesGranting(route.permission).length === 0);
  expect(ungranted).toEqual([]);
});

contractTest('a signed-in member holds every permission the web surface gates on', () => {
  const member = new Set(expandRoles(['member']));
  const missing = gatedRoutes()
    .filter((route) => !route.path.startsWith('/admin'))
    .filter((route) => !member.has(route.permission));
  expect(missing).toEqual([]);
});

contractTest('admin inherits member and STILL never holds admin:write or admin:destroy', () => {
  const admin = expandRoles(['admin']);
  // The inheritance is what lets the seeded operator also use the app as a person. It must not
  // become a dashboard write: view-only is a permission the role does not hold, and this is the
  // assertion that keeps it that way once `member` grows.
  expect(admin).toContain('dashboard:read');
  expect(admin).not.toContain('admin:write');
  expect(admin).not.toContain('admin:destroy');
  // The positive control: the same expansion DOES yield the write for the role that has it, so a
  // pass above is a missing grant and not a broken expansion.
  expect(expandRoles(['operator'])).toContain('admin:write');
});
