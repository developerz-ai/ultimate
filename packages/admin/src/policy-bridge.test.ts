// The one global-state property `policy-bridge.ts` rests on: its module-scope
// `definePermissions(ADMIN_PERMISSIONS)` ADDS admin's four names to the process-global permission
// registry and never replaces what an app declared. Both tracked apps depend on it in both
// directions — `dummy/social-media-clone/apps/admin/app/admin/policy.ts` declares its own set on
// top of this one and says so in a comment.
//
// And what the bridge HANDS a policy, which lives here for the same reason: this is the ONE file
// allowed to load `policy-bridge` in this process. A second one would import it first, the module
// scope would not run again for this file's own dynamic import, and whichever file tore down last
// would leave the registry in a state the other needs — measured, both orders red. The other admin
// suites drive `staticAuthz`, a grant-list stub with no actor fields and no row, so nothing in them
// could see that every admin decision was evaluated with `actor.orgId === undefined` and
// `row === null`: an org-scoped or ownership rule could not fire, a role-only rule allowed, and
// `adminList`/`adminSearch` add no tenant predicate of their own.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { clearRegistry, entity, newId, text, uuid } from '@ultimat3/entity';
import {
  clearPermissions,
  definePermissions,
  definePolicy,
  defineRoles,
  knownPermissions,
  type Permission,
  type PolicyArgs,
  type RoleMap,
  restoreRoles,
  roleDeclarationSites,
  roleDefinitions,
} from '@ultimat3/policy';
import { memoryAuditLog } from './audit';
import type { AdminActor, AdminAuthz } from './authz';
import { adminDestroy, adminDetail, adminUpdate, type CrudCtx } from './crud';
import { ADMIN_PERMISSIONS } from './permissions';
import type { AdminRepo, AdminRow } from './registry';
import { adminResource } from './resource';

const post = entity('admin_subject_post', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid(),
    title: text({ max: 120 }),
  },
});

const ROW_ID = newId();
const OWNER_ORG = newId();
const OTHER_ORG = newId();

/** Every `PolicyArgs` the entity-level rule was handed, in order. */
const seen: PolicyArgs<unknown, unknown>[] = [];

/**
 * A real org-scoped, row-level rule: exactly the shape `docs/architecture/15-adding-a-feature.md`
 * writes, and exactly the shape that could not fire. `row === null` DENIES — no row loaded is not
 * evidence of permission.
 */
const sameOrg = (args: PolicyArgs<unknown, unknown>): boolean => {
  seen.push(args);
  const row = args.row as { orgId?: string } | null;
  return row !== null && row.orgId === args.actor?.orgId;
};

let ambientPermissions: readonly string[] = [];
let ambientRoles: RoleMap = {};
let ambientRoleSites: Readonly<Record<string, string>> = {};

// Importing this package is itself a mutation of the registry, so this file hands the process back
// exactly the set it found — otherwise it becomes the next file's ordering bug. Captured BEFORE the
// second hook below loads the bridge, which is what makes the restore total.
beforeAll(() => {
  ambientPermissions = knownPermissions();
  ambientRoles = roleDefinitions();
  ambientRoleSites = roleDeclarationSites();
});

afterAll(() => {
  clearRegistry();
  clearPermissions();
  // Every member arrived through a `definePermissions` call, so it is a `resource:verb` already.
  if (ambientPermissions.length > 0) definePermissions(ambientPermissions as readonly Permission[]);
  restoreRoles(ambientRoles, ambientRoleSites);
});

describe('the module-scope permission registration', () => {
  // Imported dynamically, inside the test: a static import would register admin's four names in
  // every process that merely loads this file, which is the hazard being pinned.
  test('registering by import alone is what lets an app never declare admin:*', async () => {
    const { adminPermissions } = await import('./policy-bridge');

    expect(adminPermissions.all).toEqual([...ADMIN_PERMISSIONS]);
    for (const permission of ADMIN_PERMISSIONS) {
      expect(knownPermissions()).toContain(permission);
    }
  });

  test("an app's own set survives it — declaration adds, it never replaces", async () => {
    definePermissions(['post:read', 'post:publish']);
    await import('./policy-bridge');

    // If `definePermissions` ever replaced instead of merging, one of these two sets would be gone
    // and every `can()` in the losing half would throw X_PERMISSION_UNKNOWN at declaration time —
    // in a shipped app, not just in a test. Order cannot matter precisely because it only adds.
    expect(knownPermissions()).toEqual(
      expect.arrayContaining(['post:read', 'post:publish', ...ADMIN_PERMISSIONS]),
    );
  });
});

/**
 * The bridge is imported DYNAMICALLY and every registration below is undone in the `afterAll`
 * above. `definePermissions` writes a process-global registry whose EMPTY state is permissive, and
 * merely importing `policy-bridge` registers admin's four names — doing either at this file's
 * module scope makes every later FILE in the run declare `can('post:read')` into
 * `X_PERMISSION_UNKNOWN`. Measured: 247 failures across `action`, `query`, `mcp` and `ai`.
 *
 * `ADMIN_PERMISSIONS` is declared here as well as by the import, because `definePermissions` merges
 * and a module evaluates once per process: a re-run of this hook in a process where something
 * already cleared them would otherwise fail at `definePolicy('admin:read')`.
 */
let authz: AdminAuthz;

beforeAll(async () => {
  const { policyAuthz } = await import('./policy-bridge');
  definePermissions([
    ...ADMIN_PERMISSIONS,
    'admin_subject_post:read',
    'admin_subject_post:write',
    'admin_subject_post:delete',
  ]);
  // The role really holds every permission asked for below, so a denial in these tests is the ROW
  // rule refusing and never `actorHas` — which is the distinction they exist to draw. Named for
  // this file so the merge cannot collide with an app's own `admin`.
  defineRoles({ 'admin-subject-probe': { grants: ['admin:*', 'admin_subject_post:*'] } });
  authz = policyAuthz({
    policies: {
      'admin:read': definePolicy('admin:read', { deny: 'admin.denied', check: () => true }),
      'admin:write': definePolicy('admin:write', { deny: 'admin.denied', check: () => true }),
      'admin:destroy': definePolicy('admin:destroy', { deny: 'admin.denied', check: () => true }),
      'admin_subject_post:read': definePolicy('admin_subject_post:read', {
        deny: 'admin.denied',
        check: sameOrg,
      }),
      'admin_subject_post:write': definePolicy('admin_subject_post:write', {
        deny: 'admin.denied',
        check: sameOrg,
      }),
      'admin_subject_post:delete': definePolicy('admin_subject_post:delete', {
        deny: 'admin.denied',
        check: sameOrg,
      }),
    },
  });
});

const repo = (): AdminRepo<AdminRow> => {
  const store = new Map<string, AdminRow>([
    [ROW_ID, { id: ROW_ID, orgId: OWNER_ORG, title: 'Draft' }],
  ]);
  return {
    list: async (): Promise<readonly AdminRow[]> => [...store.values()],
    find: async (id): Promise<AdminRow | null> => store.get(id) ?? null,
    create: async (input): Promise<AdminRow> => input,
    update: async (id, patch): Promise<AdminRow> => {
      const next = { ...(store.get(id) ?? {}), ...patch };
      store.set(id, next);
      return next;
    },
    destroy: async (id): Promise<void> => void store.delete(id),
  };
};

const resourceOver = () => adminResource(post, { repo: repo() });

const ctxFor = (actor: AdminActor): CrudCtx => ({
  actor,
  authz,
  audit: memoryAuditLog(),
  requestId: 'req_1',
});

const OWNER: AdminActor = { id: 'u_owner', roles: ['admin-subject-probe'], orgId: OWNER_ORG };
const INTRUDER: AdminActor = { id: 'u_other', roles: ['admin-subject-probe'], orgId: OTHER_ORG };

describe('the admin subject carries the tenant and the loaded row', () => {
  test("the rule sees the actor's orgId — it was undefined for every admin decision", async () => {
    seen.length = 0;
    await adminDetail(resourceOver(), ctxFor(OWNER), ROW_ID);
    expect(seen).not.toHaveLength(0);
    expect(seen.map((args) => args.actor?.orgId)).toEqual([OWNER_ORG]);
  });

  test('the rule sees the loaded row, not just { entity, id }', async () => {
    seen.length = 0;
    await adminDetail(resourceOver(), ctxFor(OWNER), ROW_ID);
    expect(seen[0]?.row).toEqual({ id: ROW_ID, orgId: OWNER_ORG, title: 'Draft' });
    expect(seen[0]?.input).toMatchObject({ entity: 'admin_subject_post', id: ROW_ID });
  });

  test('an ownership rule can now REFUSE a row from another tenant', async () => {
    const result = await adminDetail(resourceOver(), ctxFor(INTRUDER), ROW_ID);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe('denied');
  });

  test('the owner still gets the row — the rule fires, it does not just deny everything', async () => {
    const result = await adminDetail(resourceOver(), ctxFor(OWNER), ROW_ID);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.row).toMatchObject({ id: ROW_ID, orgId: OWNER_ORG });
  });

  test('update is decided against the row it is about to overwrite', async () => {
    const resource = resourceOver();
    const refused = await adminUpdate(resource, ctxFor(INTRUDER), ROW_ID, { title: 'Hijacked' });
    expect(refused.ok).toBe(false);

    const allowedResult = await adminUpdate(resource, ctxFor(OWNER), ROW_ID, {
      title: 'Published',
    });
    expect(allowedResult.ok).toBe(true);
    if (allowedResult.ok) expect(allowedResult.row?.['title']).toBe('Published');
  });

  test('delete is decided against the row it is about to remove', async () => {
    const resource = resourceOver();
    const refused = await adminDestroy(
      resource,
      ctxFor(INTRUDER),
      ROW_ID,
      `admin_subject_post:${ROW_ID}`,
    );
    expect(refused.ok).toBe(false);

    const removed = await adminDestroy(
      resource,
      ctxFor(OWNER),
      ROW_ID,
      `admin_subject_post:${ROW_ID}`,
    );
    expect(removed.ok).toBe(true);
  });

  test('a missing row is `null`, never absent — the rule fails closed on it', async () => {
    seen.length = 0;
    const result = await adminDetail(resourceOver(), ctxFor(OWNER), newId());
    expect(seen[0]?.row).toBeNull();
    expect(result.ok).toBe(false);
  });
});
