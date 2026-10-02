// The `CrudCtx` a test hands a page or a CRUD call: an actor, the grants it holds, and an audit
// log the test can read back. A custom page's component cannot be called without one, and nothing
// minted one short of the app's whole admin.

import { describe, expect, test } from 'bun:test';
import { decideAll } from './authz';
import { adminTestCtx } from './test-ctx';

describe('unit · adminTestCtx', () => {
  test('no input is an actor with no grant: every gate refuses, by name', () => {
    const ctx = adminTestCtx();
    const decision = decideAll(ctx.authz, ['admin:read'], ctx.actor);
    expect(decision.allowed).toBe(false);
    expect(decision.permission).toBe('admin:read');
    expect(ctx.actor.id).toBe('test-admin');
    expect(ctx.requestId).toBe('test-admin-request');
  });

  test('the grants are the ones it is given — and the admin’s own implications with them', () => {
    const ctx = adminTestCtx({ granted: ['admin:write', 'ops:read'] });
    expect(decideAll(ctx.authz, ['admin:read', 'ops:read'], ctx.actor).allowed).toBe(true);
    expect(decideAll(ctx.authz, ['admin:destroy'], ctx.actor).allowed).toBe(false);
  });

  test('the actor and the request id are the caller’s when it names them', () => {
    const ctx = adminTestCtx({
      actor: { id: 'ana', orgId: 'org_1', timeZone: 'Europe/Madrid' },
      requestId: 'req_7',
    });
    expect(ctx.actor).toEqual({ id: 'ana', orgId: 'org_1', timeZone: 'Europe/Madrid' });
    expect(ctx.requestId).toBe('req_7');
  });

  test('each call has its own audit log, readable back', async () => {
    const first = adminTestCtx();
    const second = adminTestCtx();
    await first.audit.append({
      requestId: first.requestId,
      actor: first.actor,
      operation: 'list',
      kind: 'operation',
      entity: 'posts',
      entityId: null,
      permission: 'admin:read',
      outcome: 'allowed',
      reason: 'test',
    });
    expect(await first.audit.entries()).toHaveLength(1);
    expect(await second.audit.entries()).toHaveLength(0);
  });
});
