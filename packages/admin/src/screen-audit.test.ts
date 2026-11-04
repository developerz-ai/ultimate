// `/admin/audit`, rendered as a request renders it: every entry is reachable by paging, filtered or
// not; a filter survives the older link; the actor's tenant is the only one drawn, whatever the URL
// or the log says; an app's own log that ignores a field draws no entry it should not; and a
// sensitive field's value is masked even when the entry holds it in clear.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ctxOf, REDACTED, runWithContext, userActor } from '@ultimat3/core';
import { clearRegistry, database, entity, memoryDriver, text, uuid } from '@ultimat3/entity';
import { resetCatalogs } from '@ultimat3/i18n';
import {
  defineRoles,
  knownPermissions,
  permissionDeclarationSites,
  restorePermissions,
  roleDefinitions,
} from '@ultimat3/policy';
import type { AdminApp } from './admin';
import { type AuditDraft, type AuditLog, memoryAuditLog } from './audit';

const { renderComponent } = await import('@ultimat3/render/server');
const { defineAdmin } = await import('./admin');
const { adminRouteMatch } = await import('./routes');

const previousRoles = roleDefinitions();
const previousPermissions = knownPermissions();
const previousPermissionSites = permissionDeclarationSites();

const ENTITY = 'screen_audit_notes';
const notes = entity(ENTITY, {
  columns: { id: uuid().primaryKey(), title: text({ max: 80 }), email: text({ max: 80 }) },
});

const ORG_A = 'org-a';
const ORG_B = 'org-b';
const PLAINTEXT = 'ada@example.test';

const draft = (actorId: string, over: Partial<AuditDraft> = {}): AuditDraft => ({
  requestId: `req-${actorId}`,
  actor: { id: actorId, roles: ['auditor'], orgId: ORG_A },
  operation: 'update',
  kind: 'operation',
  entity: ENTITY,
  entityId: null,
  permission: `${ENTITY}:write`,
  outcome: 'allowed',
  reason: 'admin.policy.all-granted',
  diff: [],
  ...over,
});

/** An app's own log that drops `outcome` and the tenant on the floor — what the screen re-checks. */
const careless = (inner: AuditLog): AuditLog => ({
  kind: 'careless',
  append: (entry) => inner.append(entry),
  entries: ({ outcome: _outcome, orgId: _orgId, ...rest } = {}) => inner.entries(rest),
  atomic: (run) => inner.atomic(run),
});

let paged: AdminApp;
let custom: AdminApp;
let rowId = '';

beforeAll(async () => {
  defineRoles({
    ...previousRoles,
    auditor: { grants: ['admin:read', 'audit:read', `${ENTITY}:read`] },
    // Reads the trail, not the notes: a row link would be a link to a 403.
    clerk: { grants: ['admin:read', 'audit:read'] },
  });
  const db = database({ notes }, { driver: memoryDriver() });
  const resources = { [ENTITY]: { fields: { email: { sensitive: true } } } };
  const trail = memoryAuditLog({ capacity: 5_000 });
  paged = defineAdmin({ entities: [notes], db, resources, audit: trail });
  rowId = String((await db.notes.insert({ title: 'One note', email: PLAINTEXT })).id);
  // 101 changes in org A, oldest first: `u-000` is the one entry a 100-entry page cannot reach.
  for (let n = 0; n <= 100; n++) await trail.append(draft(`u-${String(n).padStart(3, '0')}`));
  // 101 refusals, so a filtered trail needs its older link too.
  for (let n = 0; n <= 100; n++) {
    await trail.append(draft(`d-${String(n).padStart(3, '0')}`, { outcome: 'denied' }));
  }
  await trail.append(draft('u-org-b-secret', { actor: { id: 'u-org-b-secret', orgId: ORG_B } }));
  // An entry that holds a sensitive value in clear, as a log written before the field was
  // marked would: the screen masks it anyway.
  await trail.append(
    draft('u-wrote-email', {
      entityId: rowId,
      diff: [{ field: 'email', before: PLAINTEXT, after: 'b@example.test' }],
    }),
  );

  const inner = memoryAuditLog();
  custom = defineAdmin({ entities: [notes], db, audit: careless(inner), basePath: '/ops' });
  await inner.append(draft('u-allowed'));
  await inner.append(draft('u-denied', { outcome: 'denied' }));
  await inner.append(
    draft('u-other-org', { outcome: 'denied', actor: { id: 'u-other-org', orgId: ORG_B } }),
  );
});

afterAll(() => {
  defineRoles(previousRoles);
  restorePermissions(previousPermissions, previousPermissionSites);
  clearRegistry();
  resetCatalogs();
});

/** One GET, as `role` of `orgId` (`null`: of no org): the status and the rendered HTML. */
const get = (app: AdminApp, path: string, role = 'auditor', orgId: string | null = ORG_A) =>
  runWithContext(
    ctxOf({
      actor: userActor({ id: 'u-reader', roles: [role], ...(orgId === null ? {} : { orgId }) }),
      tz: 'UTC',
      locale: 'en',
    }),
    async () => {
      const url = `http://localhost${path}`;
      const matched = adminRouteMatch(app, new URL(url).pathname);
      if (matched === null) return expect.unreachable(`no admin route matches ${path}`);
      const response = await matched.route.respond({
        ctx: await app.requestCtx(new Request(url)),
        params: matched.params,
        url,
        method: 'GET',
        form: null,
      });
      if (response.kind !== 'document') return expect.unreachable(`${path} redirected`);
      const html = await renderComponent(() => response.body, {}, 'apps/admin/app/admin/page.tsx');
      return { status: response.status, html };
    },
  );

/** The older link's href, as a path the next request can GET. */
const olderOf = (html: string): string | null => {
  const found = /<a[^>]*href="([^"]*before=[^"]*)"/.exec(html);
  return found?.[1] === undefined ? null : found[1].replaceAll('&amp;', '&');
};

const drawn = (html: string, prefix: string): number =>
  new Set(html.match(new RegExp(`>${prefix}-\\d{3}<`, 'g')) ?? []).size;

describe('unit · /admin/audit is a trail one can page and filter', () => {
  test('101 changes draw 100 and an older link, whose page draws the last one', async () => {
    const first = await get(paged, '/admin/audit?outcome=allowed');
    expect(first.status).toBe(200);
    expect(drawn(first.html, 'u')).toBe(99);
    const older = olderOf(first.html);
    if (older === null) return expect.unreachable('page one has no older link');
    const second = await get(paged, older);
    expect(second.html).toContain('>u-000<');
    expect(olderOf(second.html)).toBeNull();
  });

  test('a filtered older link keeps its filter', async () => {
    const first = await get(paged, '/admin/audit?outcome=denied');
    expect(drawn(first.html, 'd')).toBe(100);
    expect(drawn(first.html, 'u')).toBe(0);
    const older = olderOf(first.html);
    if (older === null) return expect.unreachable('the filtered page has no older link');
    expect(older).toContain('outcome=denied');
    const second = await get(paged, older);
    expect(drawn(second.html, 'd')).toBe(1);
    expect(second.html).toContain('>d-000<');
    expect(drawn(second.html, 'u')).toBe(0);
  });

  test('another org’s entry is absent, and the URL cannot ask for it', async () => {
    const mine = await get(paged, '/admin/audit?actor=u-org-b-secret');
    expect(mine.status).toBe(200);
    expect(mine.html).not.toContain('>u-org-b-secret<');
    const forged = await get(paged, `/admin/audit?org=${ORG_B}`);
    expect(forged.status).toBe(400);
    expect(forged.html).toContain('X_ADMIN_FILTER_INVALID');
    expect(forged.html).not.toContain('>u-org-b-secret<');
    // The platform operator, with no org, reads every tenant's.
    const platform = await get(paged, '/admin/audit?actor=u-org-b-secret', 'auditor', null);
    expect(platform.html).toContain('>u-org-b-secret<');
  });

  test('a custom log that ignores outcome and tenant draws only what was asked', async () => {
    const page = await get(custom, '/ops/audit?outcome=denied');
    expect(page.html).toContain('>u-denied<');
    expect(page.html).not.toContain('>u-allowed<');
    expect(page.html).not.toContain('>u-other-org<');
  });

  test('a sensitive field is masked on the trail and on the row’s history', async () => {
    const trail = await get(paged, '/admin/audit?actor=u-wrote-email');
    expect(trail.html).toContain('u-wrote-email');
    expect(trail.html).not.toContain(PLAINTEXT);
    expect(trail.html).toContain(REDACTED);
    const history = await get(paged, `/admin/${ENTITY}/${rowId}`);
    expect(history.html).toContain('u-wrote-email');
    expect(history.html).not.toContain(PLAINTEXT);
  });

  test('an entity links to its row only for an actor who may read the row', async () => {
    const reader = await get(paged, '/admin/audit?actor=u-wrote-email');
    expect(reader.html).toContain(`href="/admin/${ENTITY}/${rowId}"`);
    const clerk = await get(paged, '/admin/audit?actor=u-wrote-email', 'clerk');
    expect(clerk.status).toBe(200);
    expect(clerk.html).not.toContain(`href="/admin/${ENTITY}/${rowId}"`);
  });

  test('a bad bound is a 400 naming what the trail answers, never the whole trail', async () => {
    const page = await get(paged, '/admin/audit?since=last-week');
    expect(page.status).toBe(400);
    expect(page.html).toContain('since=last-week');
    expect(drawn(page.html, 'u')).toBe(0);
  });
});
