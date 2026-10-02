// The whole dashboard, in one call — and the only file that serves it. Columns, filters,
// validation and labels are DERIVED from the entities, the rows are read through the app's own
// typed handle, and `x dev` and the container mount every screen under `/admin`: there is no page
// file, no repo adapter and no screen glue in this app. The three seams `@ultimat3/admin`
// documents are each used exactly once: `actions` (suspend — on an active user, one row or a
// whole selection), `resources` (per-entity overrides, the user's sections and related lists),
// and `pages` (the ops board, which no generator would have written). The jobs dashboard —
// `/admin/jobs` and its runs, queues, tasks and workers — is every admin's, declared by nothing.

import { db, schema } from '@social-media-clone/db';
import {
  type AdminApp,
  adminRepoFor,
  defineAdmin,
  memoryAuditLog,
  policyAuthz,
  postgresAuditLog,
} from '@ultimat3/admin';
import { opsPage } from './pages/ops';
import { adminPolicies } from './policy';

/**
 * `branding.accent` is deliberately absent. `ThemeTokenRef` is `--x-${string}`
 * (packages/admin/src/theme.ts:7) while `@ultimat3/ui` emits its palette as `--color-<role>`
 * (packages/ui/src/tokens/_colors.scss:65), so any accent alias declared here would typecheck and
 * then resolve to nothing. Reported rather than papered over with a raw colour.
 */
export const admin: AdminApp = defineAdmin({
  entities: [schema.users, schema.posts, schema.media],
  // The app's typed handle, once: each resource reads and writes through its own table there —
  // soft delete included, so a deleted post is absent from the list by the entity's own rule.
  db,
  resources: {
    users: {
      labelField: 'handle',
      listFields: ['handle', 'displayName', 'role', 'suspended', 'createdAt'],
      // Not a sealed column — the app reads it — so `sensitive` is said here or it is absent. It
      // keeps the address out of the list, out of the form and out of every audit diff.
      fields: { email: { sensitive: true } },
      // Two named groups; every other column (bio, avatar key, timestamps) falls into the default
      // section below them, so a column added to `users` is on this page the day it lands.
      sections: [
        { titleKey: 'admin.users.section.profile', fields: ['handle', 'displayName', 'role'] },
        { titleKey: 'admin.users.section.account', fields: ['suspended', 'locale', 'tz'] },
      ],
      // The person's posts and uploads, each drawn as THAT resource's own list filtered to them.
      related: ['posts', 'media'],
    },
    posts: {
      labelField: 'body',
      listFields: ['body', 'audience', 'likeCount', 'commentCount', 'publishedAt'],
    },
    media: {
      labelField: 'key',
      listFields: ['key', 'kind', 'state', 'bytes', 'createdAt'],
    },
  },
  actions: [
    {
      name: 'user.suspend',
      // Its own permission, AND the admin-level `admin:write` that `permissionsForAction()` puts
      // in front of it. The demo operator holds neither, so the button is absent and the call is
      // refused by that same decision — one answer, two surfaces.
      permission: 'users:suspend',
      entity: 'users',
      labelKey: 'admin.action.user.suspend',
      // On a user who is not already suspended — the button, each list row, and the server's own
      // second look before the handler runs.
      when: (row) => row['suspended'] !== true,
      // In the list's batch bar: the checked users, or every user the list's filter matches.
      batch: true,
      async handle({ input }) {
        const id = String(input.id ?? '');
        // Through the admin's own adapter, so the id off the URL is PARSED by the key column
        // before it reaches the driver — never cast.
        const row = await adminRepoFor(schema.users, db.users).update(id, { suspended: true });
        return { id, suspended: row.suspended === true };
      },
    },
  ],
  /**
   * The escape hatch, used once. `/admin/ops` is not a resource and no generator would have
   * written it, so it arrives here as data: `pageRoutes()` gives it the same route table entry a
   * generated screen gets, `pagePermissions()` puts `admin:read` in front of its own `job:read`,
   * and `guardedScreen()` decides it. Declaring it anywhere else — a route file with its own
   * `defineRoute` and its own permission check, which is what this app had — is a page whose authz
   * nothing enforces.
   */
  pages: [opsPage],
  branding: { nameKey: 'admin.brand.name', mode: 'system', density: 'comfortable' },
  auth: {
    // `actor` is left to its default: the one the HTTP pipeline resolved for this request, so the
    // dashboard has no session lookup of its own beside the app's.
    // The app's own policies, never a grant list: `staticAuthz()` exists for tests and `x dev
    // --actor`, and using it here would be the second authz path this package is built to prevent.
    authz: policyAuthz({ policies: adminPolicies }),
  },
  // Durable wherever there is a database: the boot applies `x_admin_audit` with every other
  // framework table, so a user's history survives a deploy. A process with no database (a unit
  // test, `x dev` before Postgres is up) keeps the in-memory log.
  audit: Bun.env['DATABASE_URL'] ? postgresAuditLog() : memoryAuditLog(),
});
