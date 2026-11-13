import { afterEach, describe, expect, test } from 'bun:test';
import { userActor } from './actor';
import { ctxOf, runWithContext, useContext, withChildContext } from './context';
import {
  defineService,
  registeredServiceNames,
  registeredServices,
  resetServices,
  restoreServices,
} from './service';

afterEach(() => {
  resetServices();
});

describe('defineService', () => {
  test('installs a registered factory automatically, bound to the actor that built it', () => {
    defineService('tenant', (ctx) => ({ orgId: ctx.actor.orgId }));

    const ctx = ctxOf({ actor: userActor({ id: 'ada', orgId: 'acme' }) });

    expect(ctx.services['tenant']).toEqual({ orgId: 'acme' });
  });

  test('rebuilds a managed service on impersonation instead of carrying the parent instance', () => {
    // A regression test for the exact bug the "bound to the ctx it was built for" comment in
    // service.ts warns about: reusing a cached instance across an actor swap leaks one tenant's
    // service into another's request.
    defineService('tenant', (ctx) => ({ orgId: ctx.actor.orgId }));

    const parent = ctxOf({ actor: userActor({ id: 'ada', orgId: 'acme' }) });
    runWithContext(parent, () => {
      expect(useContext().services['tenant']).toEqual({ orgId: 'acme' });
      withChildContext({ actor: userActor({ id: 'mara', orgId: 'tinta' }) }, () => {
        expect(useContext().services['tenant']).toEqual({ orgId: 'tinta' });
      });
      // Back in the parent, the parent's own instance is untouched.
      expect(useContext().services['tenant']).toEqual({ orgId: 'acme' });
    });
  });

  test('an explicit service in ctxOf overrides a registered factory of the same name', () => {
    defineService('tenant', (ctx) => ({ orgId: ctx.actor.orgId }));

    const ctx = ctxOf({
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

describe('registeredServices / restoreServices', () => {
  test('the registry becomes exactly what was handed back, factories included', () => {
    const first = defineService('first', () => 1);
    defineService('second', () => 2);
    const held = registeredServices();
    expect(held).toEqual([
      { name: 'first', factory: first },
      { name: 'second', factory: expect.any(Function) },
    ]);
    restoreServices(held.filter((entry) => entry.name !== 'second'));
    expect(registeredServiceNames()).toEqual(['first']);
    // Forgotten, so declared afresh — and the kept name is still refused.
    expect(() => defineService('second', () => 3)).not.toThrow();
    expect(() => defineService('first', () => 4)).toThrow(/X_SERVICE_DUPLICATE/);
    expect(ctxOf({ actor: userActor({ id: 'ada', orgId: 'acme' }) }).services).toEqual({
      first: 1,
      second: 3,
    });
  });

  test('a read is a copy: a later registration does not reach it', () => {
    defineService('first', () => 1);
    const held = registeredServices();
    defineService('later', () => 2);
    expect(held.map((entry) => entry.name)).toEqual(['first']);
  });
});
