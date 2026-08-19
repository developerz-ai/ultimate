// The wrapper that makes a custom page's authz unskippable. Three things have to hold at once:
// the author's component is not called on a refusal, the refusal is AUDITED, and the operator is
// told which permission refused them rather than being redirected or 404'd.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { registerCatalog } from '@ultimat3/i18n';
import type { AdminRoute } from './admin';
import { type AuditEntry, memoryAuditLog } from './audit';
import {
  type AdminActor,
  type AdminAuthz,
  type AdminAuthzQuery,
  type AdminDecision,
  allowed,
  denied,
} from './authz';
import type { CrudCtx } from './crud';
import {
  byTag,
  installFactory,
  nodesOf,
  one,
  renderHtml,
  restoreFactory,
  shallowNodesOf,
} from './inert-jsx';
import type { AdminPageProps } from './pages';

// Dynamic, and for the reason `detail-render.test.ts` states: `@ultimat3/render`'s `Bun.plugin`
// is the JSX factory these views compile through, and a plugin only transforms modules loaded
// after it. Nothing else in this package may reach `page-guard.tsx` statically.
await import('@ultimat3/render');
const { AdminPageDenied, guardedPage } = await import('./page-guard');

registerCatalog('en', {
  'admin.ops.title': 'Ops (probe)',
  'admin.denied.body': 'Refused {permission} because {reason} (probe)',
});

beforeAll(installFactory);
afterAll(restoreFactory);

const ACTOR: AdminActor = { id: 'u_1', roles: ['viewer'], orgId: 'org_1' };

const ROUTE: AdminRoute = {
  path: '/back-office/ops',
  view: 'page',
  entity: null,
  titleKey: 'admin.ops.title',
  permissions: ['admin:read', 'ops:read'],
};

function ctxFor(authz: AdminAuthz): CrudCtx {
  return { actor: ACTOR, authz, audit: memoryAuditLog(), requestId: 'req_page' };
}

const props = (ctx: CrudCtx): AdminPageProps => ({ ctx, params: {}, url: '/back-office/ops' });

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
        ? allowed(query.permission, 'probe.granted')
        : denied(query.permission, 'probe.no-ops-grant');
    },
  };
}

describe('an allowed actor reaches the author’s component', () => {
  test('the component is called once, with the props the router handed the wrapper', async () => {
    const seen: AdminPageProps[] = [];
    const guarded = guardedPage(ROUTE, (given) => {
      seen.push(given);
      return 'the page body';
    });
    const ctx = ctxFor(recordingAuthz(new Set(['admin:read', 'ops:read'])));

    expect(await guarded(props(ctx))).toBe('the page body');
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe('/back-office/ops');
    // An allowed page is not an authz event: nothing is written for a screen that rendered.
    expect(ctx.audit.entries()).toEqual([]);
  });

  test('every declared permission is asked, in the order the route declares them', async () => {
    const authz = recordingAuthz(new Set(['admin:read', 'ops:read']));
    await guardedPage(ROUTE, () => null)(props(ctxFor(authz)));
    expect(authz.asked.map((query) => query.permission)).toEqual(['admin:read', 'ops:read']);
    // A page has no row and no entity to decide about — the SUBJECT is the path itself.
    expect(authz.asked.every((query) => query.subject === undefined)).toBe(true);
    expect(authz.asked.every((query) => query.actor === ACTOR)).toBe(true);
  });
});

describe('a refused actor never reaches the author’s component', () => {
  const refused = (): { readonly ctx: CrudCtx; readonly calls: number[] } => ({
    ctx: ctxFor(recordingAuthz(new Set(['admin:read']))),
    calls: [],
  });

  test('the component is not called at all', async () => {
    const fixture = refused();
    const guarded = guardedPage(ROUTE, () => {
      fixture.calls.push(1);
      return 'the page body';
    });

    const rendered = await guarded(props(fixture.ctx));
    expect(fixture.calls).toEqual([]);
    expect(renderHtml(rendered)).not.toContain('the page body');
  });

  test('the refusal is audited against the PATH, with no entity id to key a screen by', async () => {
    const fixture = refused();
    await guardedPage(ROUTE, () => 'body')(props(fixture.ctx));

    const entries: readonly AuditEntry[] = fixture.ctx.audit.entries();
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    expect(entry).toBeDefined();
    if (entry === undefined) return;

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
    // DEEP: the wrapper returns `<AdminPageDenied>`, a component — the shallow walk stops there.
    const nodes = nodesOf(await guardedPage(ROUTE, () => 'body')(props(fixture.ctx)));

    const section = one(byTag(nodes, 'section'), '<section>');
    // Not a redirect and not a 404: a missing grant is a state an operator can act on.
    expect(section.props['role']).toBe('alert');
    expect(section.props['class']).toBe('x-admin-denied');
    expect(one(byTag(nodes, 'h1'), '<h1>').props['children']).toBe('Ops (probe)');
    expect(one(byTag(nodes, 'p'), '<p>').props['children']).toBe(
      'Refused ops:read because probe.no-ops-grant (probe)',
    );
  });
});

describe('AdminPageDenied renders the decision it was handed', () => {
  test('the failing permission and reason are both interpolated, never the whole decision', () => {
    const nodes = shallowNodesOf(
      AdminPageDenied({
        titleKey: 'admin.ops.title',
        decision: denied('billing:write', 'admin.policy.not-granted'),
      }),
    );
    expect(one(byTag(nodes, 'p'), '<p>').props['children']).toBe(
      'Refused billing:write because admin.policy.not-granted (probe)',
    );
  });
});
