// The wrapper that makes a screen's authz unskippable. Four things have to hold at once: the
// author's component is not called on a refusal, the refusal is AUDITED, it answers 403, and the
// operator is told which permission refused them rather than being redirected or 404'd.

import { afterAll, describe, expect, test } from 'bun:test';
import { clearRegistry } from '@ultimat3/entity';
import { registerCatalog } from '@ultimat3/i18n';
import { type AdminRoute, defineAdmin } from './admin';
import { type AuditEntry, memoryAuditLog } from './audit';
import {
  type AdminActor,
  type AdminAuthz,
  type AdminAuthzQuery,
  type AdminDecision,
  adminAllowed,
  adminDenied,
} from './authz';
import type { CrudCtx } from './crud';
import type { AdminRouteRequest, AdminRouteResponse } from './screen-frame';

// Dynamic, and for the reason `detail-render.test.ts` states: `@ultimat3/render`'s `Bun.plugin`
// is the JSX factory these views compile through, and a plugin only transforms modules loaded
// after it. Nothing else in this package may reach a `.tsx` statically.
const { renderComponent } = await import('@ultimat3/render/server');
const { AdminPageDenied, auditRefusal } = await import('./page-guard');
const { guardedScreen } = await import('./screen-frame');

registerCatalog('en', {
  'admin.ops.title': 'Ops (probe)',
  'admin.denied.body': 'Refused {permission} because {reason} (probe)',
});

afterAll(clearRegistry);

const ACTOR: AdminActor = { id: 'u_1', roles: ['viewer'], orgId: 'org_1' };

const ROUTE: AdminRoute = {
  path: '/back-office/ops',
  view: 'page',
  entity: null,
  titleKey: 'admin.ops.title',
  permissions: ['admin:read', 'ops:read'],
};

/** Answers from a grant set AND keeps the questions, so "what was decided" is assertable. */
function recordingAuthz(grant: ReadonlySet<string>): AdminAuthz & {
  readonly asked: AdminAuthzQuery[];
} {
  const asked: AdminAuthzQuery[] = [];
  return {
    asked,
    decide(query): AdminDecision {
      asked.push(query);
      return grant.has(query.permission)
        ? adminAllowed(query.permission, 'probe.granted')
        : adminDenied(query.permission, 'probe.no-ops-grant');
    },
  };
}

function ctxFor(authz: AdminAuthz): CrudCtx {
  return { actor: ACTOR, authz, audit: memoryAuditLog(), requestId: 'req_page' };
}

const appFor = (authz: AdminAuthz) =>
  defineAdmin({ entities: [], basePath: '/back-office', auth: { actor: () => ACTOR, authz } });

const request = (ctx: CrudCtx): AdminRouteRequest => ({
  ctx,
  params: {},
  url: 'http://localhost/back-office/ops',
  method: 'GET',
  form: null,
});

const html = (response: AdminRouteResponse): Promise<string> =>
  response.kind === 'document'
    ? renderComponent(() => response.body, {}, 'apps/admin/app/admin/page.tsx')
    : Promise.resolve('');

const FULL = new Set(['admin:read', 'ops:read']);

describe('an allowed actor reaches the author’s component', () => {
  test('the body is called once, with the request the host handed the screen', async () => {
    const authz = recordingAuthz(FULL);
    const seen: AdminRouteRequest[] = [];
    const screen = guardedScreen(appFor(authz), ROUTE, (given) => {
      seen.push(given);
      return 'the page body';
    });
    const ctx = ctxFor(authz);

    const response = await screen(request(ctx));
    expect(response.kind === 'document' && response.status).toBe(200);
    expect(await html(response)).toContain('the page body');
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe('http://localhost/back-office/ops');
    // An allowed page is not an authz event: nothing is written for a screen that rendered.
    expect(await ctx.audit.entries()).toEqual([]);
  });

  test('every declared permission is asked, in the order the route declares them', async () => {
    const authz = recordingAuthz(FULL);
    await guardedScreen(appFor(authz), ROUTE, () => null)(request(ctxFor(authz)));
    const asked = authz.asked.slice(0, 2);
    expect(asked.map((query) => query.permission)).toEqual(['admin:read', 'ops:read']);
    // A page has no row and no entity to decide about — the SUBJECT is the path itself.
    expect(asked.every((query) => query.subject === undefined)).toBe(true);
    expect(asked.every((query) => query.actor === ACTOR)).toBe(true);
  });

  test('the body sits inside the shell, under the route’s own title', async () => {
    const authz = recordingAuthz(FULL);
    const out = await html(
      await guardedScreen(appFor(authz), ROUTE, () => 'the page body')(request(ctxFor(authz))),
    );
    expect(out).toMatch(/<h1[^>]*>Ops \(probe\)<\/h1>/);
    expect(out).toContain('id="x-admin-main"');
  });
});

describe('a refused actor never reaches the author’s component', () => {
  const refused = () => {
    const authz = recordingAuthz(new Set(['admin:read']));
    return { app: appFor(authz), ctx: ctxFor(authz), calls: [] as number[] };
  };

  test('the body is not called at all, and the answer is a 403', async () => {
    const fixture = refused();
    const response = await guardedScreen(fixture.app, ROUTE, () => {
      fixture.calls.push(1);
      return 'the page body';
    })(request(fixture.ctx));

    expect(fixture.calls).toEqual([]);
    expect(response.kind === 'document' && response.status).toBe(403);
    expect(await html(response)).not.toContain('the page body');
  });

  test('the refusal is audited against the PATH, with no entity id to key a screen by', async () => {
    const fixture = refused();
    await guardedScreen(fixture.app, ROUTE, () => 'body')(request(fixture.ctx));

    const entries: readonly AuditEntry[] = await fixture.ctx.audit.entries();
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    if (entry === undefined) return expect.unreachable('one entry was asserted above');

    expect(entry.outcome).toBe('denied');
    expect(entry.operation).toBe('page');
    expect(entry.kind).toBe('operation');
    expect(entry.entity).toBe('/back-office/ops');
    expect(entry.entityId).toBeNull();
    expect(entry.permission).toBe('ops:read');
    expect(entry.reason).toBe('probe.no-ops-grant');
    expect(entry.requestId).toBe('req_page');
  });

  test('the operator reads WHICH permission refused them, in an alert', async () => {
    const fixture = refused();
    const out = await html(
      await guardedScreen(fixture.app, ROUTE, () => 'body')(request(fixture.ctx)),
    );
    // Not a redirect and not a 404: a missing grant is a state an operator can act on.
    expect(out).toContain('<section class="x-admin-denied" role="alert">');
    expect(out).toContain('Refused ops:read because probe.no-ops-grant (probe)');
    // ONE heading: the refusal carries the title, so the shell does not draw a second `<h1>`.
    expect(out.match(/<h1/g) ?? []).toHaveLength(1);
  });
});

describe('the refusal’s two halves, on their own', () => {
  test('AdminPageDenied interpolates the failing permission and reason, never the whole decision', async () => {
    const out = await renderComponent(
      () =>
        AdminPageDenied({
          titleKey: 'admin.ops.title',
          decision: adminDenied('billing:write', 'admin.policy.not-granted'),
        }),
      {},
      'apps/admin/app/admin/page.tsx',
    );
    expect(out).toContain('Refused billing:write because admin.policy.not-granted (probe)');
  });

  test('auditRefusal writes one denied entry keyed on the path it was given', async () => {
    const ctx = ctxFor(recordingAuthz(new Set()));
    await auditRefusal(ctx, '/back-office/posts/new', adminDenied('admin:write', 'probe.reason'));
    expect(
      (await ctx.audit.entries()).map((entry) => [entry.entity, entry.outcome, entry.reason]),
    ).toEqual([['/back-office/posts/new', 'denied', 'probe.reason']]);
  });
});
