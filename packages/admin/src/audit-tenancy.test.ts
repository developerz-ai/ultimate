// The audit trail is tenant-scoped on every screen that reads it: an org-A actor holding
// `audit:read` opens `/admin/audit`, and a row's history card, and sees no entry an org-B actor
// wrote — the probe that reproduced the leak. An actor with no org (the platform) sees both.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createContext, runWithContext, userActor } from '@ultimat3/core';
import { clearRegistry, database, entity, memoryDriver, text, uuid } from '@ultimat3/entity';
import { resetCatalogs } from '@ultimat3/i18n';
import {
  defineRoles,
  knownPermissions,
  restorePermissions,
  roleDefinitions,
} from '@ultimat3/policy';
import type { AdminApp } from './admin';

const { renderComponent } = await import('@ultimat3/render/server');
const { defineAdmin } = await import('./admin');
const { adminRouteMatch } = await import('./routes');

const previousRoles = roleDefinitions();
const previousPermissions = knownPermissions();

// Not tenant-scoped: one row both orgs may open, so only the trail itself can keep them apart.
const notes = entity('admin_audit_tenancy_notes', {
  columns: { id: uuid().primaryKey(), title: text({ max: 80 }) },
});

const ORG_A = 'org-a';
const ORG_B = 'org-b';
const LEAK = 'u-org-b-secret-actor';

let admin: AdminApp;
let rowId = '';

beforeAll(async () => {
  const db = database({ notes }, { driver: memoryDriver() });
  admin = defineAdmin({ entities: [notes], db });
  defineRoles({
    ...previousRoles,
    auditor: { grants: ['admin:read', 'audit:read', 'admin_audit_tenancy_notes:read'] },
  });
  rowId = String((await db.notes.insert({ title: 'Shared note' })).id);
  const wrote = (id: string, orgId: string) =>
    admin.audit.append({
      requestId: `req-${id}`,
      actor: { id, roles: ['auditor'], orgId },
      operation: 'update',
      kind: 'operation',
      entity: 'admin_audit_tenancy_notes',
      entityId: rowId,
      permission: 'admin_audit_tenancy_notes:write',
      outcome: 'allowed',
      reason: 'admin.policy.all-granted',
      diff: [{ field: 'title', before: 'a', after: 'b' }],
    });
  await wrote('u-org-a-actor', ORG_A);
  await wrote(LEAK, ORG_B);
});

afterAll(() => {
  defineRoles(previousRoles);
  restorePermissions(previousPermissions);
  clearRegistry();
  resetCatalogs();
});

/** One GET as an `auditor` of `orgId` (or of no org), rendered to HTML. */
const render = (orgId: string | undefined, path: string): Promise<string> =>
  runWithContext(
    createContext({
      actor: userActor({ id: 'u-reader', roles: ['auditor'], ...(orgId ? { orgId } : {}) }),
      tz: 'UTC',
      locale: 'en',
    }),
    async () => {
      const url = `http://localhost${path}`;
      const matched = adminRouteMatch(admin, new URL(url).pathname);
      if (matched === null) return expect.unreachable(`no admin route matches ${path}`);
      const response = await matched.route.respond({
        ctx: await admin.requestCtx(new Request(url)),
        params: matched.params,
        url,
        method: 'GET',
        form: null,
      });
      if (response.kind !== 'document') return expect.unreachable(`${path} redirected`);
      expect(response.status).toBe(200);
      return renderComponent(() => response.body, {}, 'apps/admin/app/admin/page.tsx');
    },
  );

describe('unit · the audit trail is the actor’s tenant’s', () => {
  test('/admin/audit for an org-A auditor holds no org-B actor', async () => {
    const html = await render(ORG_A, '/admin/audit');
    expect(html).toContain('u-org-a-actor');
    expect(html).not.toContain(LEAK);
  });

  test('a row’s history card for an org-A reader holds no org-B entry', async () => {
    const html = await render(ORG_A, `/admin/admin_audit_tenancy_notes/${rowId}`);
    expect(html).toContain('u-org-a-actor');
    expect(html).not.toContain(LEAK);
  });

  test('an actor with no org — the platform operator — reads every tenant’s trail', async () => {
    const html = await render(undefined, '/admin/audit');
    expect(html).toContain('u-org-a-actor');
    expect(html).toContain(LEAK);
  });
});
