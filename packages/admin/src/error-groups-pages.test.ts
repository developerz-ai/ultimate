// `/admin/errors` mounted through `defineAdmin({ pages: errorGroupsPages({ store }) })`: one fault
// thrown on two requests is ONE row with a count of two, its detail shows the redacted sample, an
// unknown parameter is the list's 400, and an operator without `errors:read` is refused.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ctxOf, errorReport, runWithContext, UltimateError, userActor } from '@ultimat3/core';
import { clearRegistry, database, entity, memoryDriver, text, uuid } from '@ultimat3/entity';
import { registerCatalog, resetCatalogs } from '@ultimat3/i18n';
import {
  defineRoles,
  knownPermissions,
  permissionDeclarationSites,
  restorePermissions,
  roleDefinitions,
} from '@ultimat3/policy';
import type { AdminApp } from './admin';
import { errorGroupsSink } from './error-groups-sink';
import { memoryErrorGroupsStore } from './error-groups-store';
import type { AdminRouteResponse } from './screen-frame';

// Loaded after `@ultimat3/render/server` has installed its `.tsx` loader, and never statically.
const { renderComponent } = await import('@ultimat3/render/server');
const { defineAdmin } = await import('./admin');
const { adminRouteMatch } = await import('./routes');
const { errorGroupsPages } = await import('./error-groups-pages');

const previousRoles = roleDefinitions();
const previousPermissions = knownPermissions();
const previousSites = permissionDeclarationSites();

const notes = entity('admin_errors_notes', {
  columns: { id: uuid().primaryKey(), body: text({ max: 80 }) },
});
const db = database({ notes }, { driver: memoryDriver() });
const store = memoryErrorGroupsStore();
let admin: AdminApp;

beforeAll(async () => {
  admin = defineAdmin({ entities: [notes], db, pages: errorGroupsPages({ store }) });
  defineRoles({
    ...previousRoles,
    triage: { grants: ['admin:read', 'errors:read'] },
    reader: { grants: ['admin:read'] },
  });
  resetCatalogs();
  registerCatalog('en', { 'admin.errors.title': 'Errors', 'admin.errors.status.open': 'Open' });
  const sink = errorGroupsSink({ store });
  for (const orderId of ['o_1', 'o_2']) {
    const failure = new UltimateError({
      code: 'X_ORDER_STUCK',
      cause: `order ${orderId} is stuck`,
      fix: 'x jobs show orders --json',
      meta: { orderId, password: 'hunter2' },
    });
    sink.report(errorReport(failure, { source: 'http', scope: { operation: 'POST /orders' } }));
  }
  await sink.settled();
});

afterAll(() => {
  defineRoles(previousRoles);
  restorePermissions(previousPermissions, previousSites);
  clearRegistry();
  resetCatalogs();
});

const ask = (role: string, path: string): Promise<{ status: number; html: string }> =>
  runWithContext(
    ctxOf({ actor: userActor({ id: `u-${role}`, roles: [role] }), tz: 'UTC', locale: 'en' }),
    async () => {
      const url = `http://localhost${path}`;
      const matched = adminRouteMatch(admin, new URL(url).pathname);
      if (matched === null) return expect.unreachable(`no admin route matches ${path}`);
      const response: AdminRouteResponse = await matched.route.respond({
        ctx: await admin.requestCtx(new Request(url)),
        params: matched.params,
        url,
        method: 'GET',
        form: null,
      });
      if (response.kind !== 'document') return expect.unreachable('expected a document');
      const html = await renderComponent(() => response.body, {}, 'apps/admin/app/admin/page.tsx');
      return { status: response.status, html };
    },
  );

describe('/admin/errors', () => {
  test('one fault across two requests is one row, counted twice', async () => {
    const answer = await ask('triage', '/admin/errors');
    expect(answer.status).toBe(200);
    expect(answer.html.match(/data-fingerprint=/g)).toHaveLength(1);
    expect(answer.html).toContain('X_ORDER_STUCK');
    expect(answer.html).toContain('POST /orders');
  });

  test('the detail shows the sample, the credential redacted', async () => {
    const [group] = await store.list();
    const answer = await ask('triage', `/admin/errors/${group?.fingerprint ?? ''}`);
    expect(answer.status).toBe(200);
    expect(answer.html).toContain('o_2');
    expect(answer.html).not.toContain('hunter2');
  });

  test('a status filters; an unknown parameter or status is a 400', async () => {
    expect((await ask('triage', '/admin/errors?status=ignored')).html).not.toContain(
      'data-fingerprint=',
    );
    expect((await ask('triage', '/admin/errors?status=open')).html).toContain('data-fingerprint=');
    expect((await ask('triage', '/admin/errors?status=gone')).status).toBe(400);
    expect((await ask('triage', '/admin/errors?code=X')).status).toBe(400);
  });

  test('admin:read alone is refused: the page composes errors:read', async () => {
    expect((await ask('reader', '/admin/errors')).status).toBe(403);
  });
});
