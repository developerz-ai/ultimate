import { afterEach, describe, expect, test } from 'bun:test';
import { userActor } from './actor';
import { createContext, runWithContext, useContext, withChildContext } from './context';
import { defineService, resetServices } from './service';

afterEach(() => {
  resetServices();
});

describe('defineService', () => {
  test('installs a registered factory automatically, bound to the actor that built it', () => {
    defineService('tenant', (ctx) => ({ orgId: ctx.actor.orgId }));

    const ctx = createContext({ actor: userActor({ id: 'ada', orgId: 'acme' }) });

    expect(ctx.services['tenant']).toEqual({ orgId: 'acme' });
  });

  test('rebuilds a managed service on impersonation instead of carrying the parent instance', () => {
    // A regression test for the exact bug the "bound to the ctx it was built for" comment in
    // service.ts warns about: reusing a cached instance across an actor swap leaks one tenant's
    // service into another's request.
    defineService('tenant', (ctx) => ({ orgId: ctx.actor.orgId }));

    const parent = createContext({ actor: userActor({ id: 'ada', orgId: 'acme' }) });
    runWithContext(parent, () => {
      expect(useContext().services['tenant']).toEqual({ orgId: 'acme' });
      withChildContext({ actor: userActor({ id: 'mara', orgId: 'tinta' }) }, () => {
        expect(useContext().services['tenant']).toEqual({ orgId: 'tinta' });
      });
      // Back in the parent, the parent's own instance is untouched.
      expect(useContext().services['tenant']).toEqual({ orgId: 'acme' });
    });
  });

  test('an explicit service in createContext overrides a registered factory of the same name', () => {
    defineService('tenant', (ctx) => ({ orgId: ctx.actor.orgId }));

    const ctx = createContext({
      actor: userActor({ id: 'ada', orgId: 'acme' }),
      services: { tenant: { orgId: 'mocked' } },
    });

    expect(ctx.services['tenant']).toEqual({ orgId: 'mocked' });
  });

  test('throws X_SERVICE_DUPLICATE when the same name registers twice', () => {
    defineService('tenant', () => ({}));

    expect(() => defineService('tenant', () => ({}))).toThrow(/X_SERVICE_DUPLICATE/);
  });
});
