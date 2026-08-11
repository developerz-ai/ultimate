// The whole dashboard, in one call. Columns, filters, validation and labels are DERIVED from the
// entities — nothing here restates a column — and the three seams `@ultimat3/admin` documents are
// each used exactly once: `actions` (the suspend button), `resources` (per-entity overrides), and
// this app's own routes (`ops/page.tsx`, which the generator would never have written).

import { schema } from '@social-media-clone/db';
import {
  type AdminApp,
  type CrudCtx,
  defineAdmin,
  memoryAuditLog,
  policyAuthz,
} from '@ultimat3/admin';
import { currentAdminActor } from './actor';
import { adminPolicies } from './policy';
import { mediaAdminRepo, postsAdminRepo, usersAdminRepo } from './repo';

/**
 * `branding.accent` is deliberately absent. `ThemeTokenRef` is `--x-${string}`
 * (packages/admin/src/theme.ts:7) while `@ultimat3/ui` emits its palette as `--color-<role>`
 * (packages/ui/src/tokens/_colors.scss:65), so any accent alias declared here would typecheck and
 * then resolve to nothing. Reported rather than papered over with a raw colour.
 */
export const admin: AdminApp = defineAdmin({
  entities: [schema.users, schema.posts, schema.media],
  resources: {
    users: {
      repo: usersAdminRepo,
      // `path` is spelled out on all three: `adminResource`'s pluralizer
      // (packages/admin/src/resource.ts:93) assumes a SINGULAR entity name, and this app names its
      // entities plurally — so the default would be `/userses`, `/medias` and a nav full of 404s.
      path: '/users',
      labelField: 'handle',
      listFields: ['handle', 'displayName', 'role', 'suspended', 'createdAt'],
      // An entity has no notion of a secret column, so `sensitive` is said here or it is absent.
      // It keeps the address out of the list, out of the form and out of every audit diff.
      fields: { email: { sensitive: true } },
    },
    posts: {
      repo: postsAdminRepo,
      path: '/posts',
      labelField: 'body',
      listFields: ['body', 'audience', 'likeCount', 'commentCount', 'publishedAt'],
    },
    media: {
      repo: mediaAdminRepo,
      path: '/media',
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
      async handle({ input }) {
        const id = String(input.id ?? '');
        const row = await usersAdminRepo.update(id, { suspended: true });
        return { id, suspended: row.suspended === true };
      },
    },
  ],
  branding: { nameKey: 'admin.brand.name', mode: 'system', density: 'comfortable' },
  auth: {
    actor: () => currentAdminActor().actor,
    // The app's own policies, never a grant list: `staticAuthz()` exists for tests and `x dev
    // --actor`, and using it here would be the second authz path this package is built to prevent.
    authz: policyAuthz({ policies: adminPolicies }),
  },
  audit: memoryAuditLog(),
  // `jobs` is not passed: `describeJobs()` is a snapshot of a registry that `apps/web/api/tasks.ts`
  // fills, and module import order does not promise it ran first. The jobs page reads it live.
});

/**
 * The per-request handle every CRUD call and every nav render takes. Anonymous is a real actor id
 * here — `decideAll()` refuses it exactly as it refuses a signed-in actor missing the grant, and an
 * audit row that says `anonymous` is more useful than one that says nothing.
 */
export const adminCtxForRequest = (): CrudCtx => {
  const { actor, requestId } = currentAdminActor();
  return admin.ctx({ actor: actor ?? { id: 'anonymous', roles: [] }, requestId });
};
