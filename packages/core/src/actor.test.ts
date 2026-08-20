import { describe, expect, test } from 'bun:test';
import type { Actor, ActorInit } from './actor';
import {
  actorFact,
  actorLabel,
  actorOrigin,
  agentActor,
  anonymousActor,
  hasRole,
  hasScope,
  isAnonymous,
  serviceActor,
  userActor,
  withFacts,
} from './actor';
import { createContext, runWithContext, useContext, withChildContext } from './context';
import { impersonate } from './impersonate';

/**
 * The augmentation an app writes, exercised here against the relative module so the test is
 * typed the way an app would be. Erased at runtime; nothing in the framework declares a fact.
 */
declare module './actor' {
  interface ActorFacts {
    readonly friendIds: ReadonlySet<string>;
    readonly tier: 'free' | 'paid';
  }
}

describe('actor', () => {
  test('carries kind, roles and scopes, and labels without PII', () => {
    const actor = userActor({ id: 'ada', orgId: 'acme', roles: ['editor'], scopes: ['post:read'] });
    expect(actor.kind).toBe('user');
    expect(hasRole(actor, 'editor')).toBe(true);
    expect(hasScope(actor, 'post:read')).toBe(true);
    expect(actorLabel(actor)).toBe('user:ada@acme');
    expect(isAnonymous(anonymousActor())).toBe(true);
  });
});

describe('actor facts', () => {
  test('an actor minted without facts reads every fact as undefined', () => {
    expect(actorFact(userActor({ id: 'ada' }), 'friendIds')).toBeUndefined();
    expect(actorFact(anonymousActor(), 'friendIds')).toBeUndefined();
  });

  test('a null actor reads as undefined rather than throwing — a predicate gets a denial', () => {
    expect(actorFact(null, 'tier')).toBeUndefined();
  });

  test('a fact declared at mint time is readable', () => {
    const actor = userActor({ id: 'ada', facts: { friendIds: new Set(['mara']) } });
    expect(actorFact(actor, 'friendIds')?.has('mara')).toBe(true);
    expect(actorFact(actor, 'tier')).toBeUndefined();
  });

  test('withFacts returns a new frozen actor and leaves the original alone', () => {
    const resolved = userActor({ id: 'ada', roles: ['editor'] });
    const carrying = withFacts(resolved, { tier: 'paid' });
    expect(actorFact(carrying, 'tier')).toBe('paid');
    expect(actorFact(resolved, 'tier')).toBeUndefined();
    expect(Object.isFrozen(carrying)).toBe(true);
    expect(carrying.id).toBe('ada');
    expect(carrying.roles).toEqual(['editor']);
    expect(carrying.kind).toBe('user');
  });

  test('withFacts merges: a second resolver adds a fact without dropping the first', () => {
    const actor = withFacts(withFacts(agentActor({ id: 'mcp-1' }), { tier: 'free' }), {
      friendIds: new Set(['ada']),
    });
    expect(actorFact(actor, 'tier')).toBe('free');
    expect(actorFact(actor, 'friendIds')?.has('ada')).toBe(true);
  });

  test('the same key resolved twice takes the later value', () => {
    const actor = withFacts(withFacts(userActor({ id: 'ada' }), { tier: 'free' }), {
      tier: 'paid',
    });
    expect(actorFact(actor, 'tier')).toBe('paid');
  });

  test('facts ride the context, so every surface reads the one actor', () => {
    const actor = withFacts(userActor({ id: 'ada' }), { tier: 'paid' });
    runWithContext(createContext({ actor }), () => {
      const read = (): 'free' | 'paid' | undefined => actorFact(useContext().actor, 'tier');
      expect(read()).toBe('paid');
      // Impersonation replaces the actor, so it replaces the facts — never leaks the parent's.
      withChildContext({ actor: userActor({ id: 'mara' }) }, () => {
        expect(read()).toBeUndefined();
      });
      expect(read()).toBe('paid');
    });
  });
});

describe('actorLabel under impersonation', () => {
  test('a refund issued while impersonating does NOT read as the customer', () => {
    const customer = userActor({
      id: 'cust-99',
      orgId: 'org-3',
      onBehalfOf: { actorId: 'eng-7', actorKind: 'service' },
    });
    expect(actorLabel(customer)).toBe('service:eng-7→user:cust-99@org-3');
  });

  test('an actor acting for themselves renders unchanged — absence is a statement', () => {
    expect(actorLabel(userActor({ id: 'u1', orgId: 'org-3' }))).toBe('user:u1@org-3');
    expect(actorLabel(userActor({ id: 'u1' }))).toBe('user:u1');
  });

  test('the origin is frozen with the actor, so it cannot be edited under a policy', () => {
    const actor = userActor({ id: 'u1', onBehalfOf: { actorId: 'eng-7', actorKind: 'service' } });
    expect(Object.isFrozen(actor.onBehalfOf)).toBe(true);
  });

  test('actorOrigin is the tuple to stamp onto whoever they impersonate', () => {
    expect(actorOrigin(serviceActor({ id: 'eng-7', orgId: 'org-1' }))).toEqual({
      actorId: 'eng-7',
      actorKind: 'service',
    });
  });
});

// `permissions` is a DIRECT grant — the authz field that bypasses roles, which service tokens and
// break-glass accounts hold. It lived on `@ultimat3/policy`'s `PolicyActorFields` and not here, so
// `build()`'s explicit field list dropped it: `userActor({ permissions })` compiled, discarded the
// argument, and every call site that needed one spelled it as a spread over a frozen actor —
// producing an UNFROZEN actor whose shape production never mints.
describe('direct grants', () => {
  test('a permission handed to a builder is carried, never silently dropped', () => {
    const token = serviceActor({ id: 'svc-1', permissions: ['post:publish'] });
    expect(token.permissions).toEqual(['post:publish']);
  });

  test('an actor that declares none carries an empty list, never undefined', () => {
    expect(userActor({ id: 'ada' }).permissions).toEqual([]);
    expect(anonymousActor().permissions).toEqual([]);
  });

  test('the grant list is frozen with the actor, so no holder can widen its own authz', () => {
    const token = agentActor({ id: 'agent-1', permissions: ['post:publish'] });
    // Asserted BEFORE the freeze check, and not merged into it: `Object.isFrozen(undefined)` is
    // `true`, so a dropped field passes a bare freeze assertion without ever holding a value.
    expect(token.permissions).toEqual(['post:publish']);
    expect(Object.isFrozen(token)).toBe(true);
    expect(Object.isFrozen(token.permissions)).toBe(true);
  });

  test('the builder copies the caller’s array, so mutating it later grants nothing', () => {
    const granted = ['post:publish'];
    const token = serviceActor({ id: 'svc-1', permissions: granted });
    granted.push('post:delete');
    expect(token.permissions).toEqual(['post:publish']);
  });

  test('impersonation carries the grants of the actor being impersonated, not the caller’s', () => {
    const support = serviceActor({ id: 'eng-7', permissions: ['support:read'] });
    const customer = userActor({ id: 'cust-99', permissions: ['post:publish'] });
    const seen = runWithContext(createContext({ actor: support }), () =>
      impersonate(customer, 'ticket 4821', () => useContext().actor),
    );
    expect(seen.permissions).toEqual(['post:publish']);
    expect(Object.isFrozen(seen)).toBe(true);
  });

  // The three totals: each threw or lied on the malformed actor `testActor()` used to mint.
  test('hasScope, actorLabel and isAnonymous stay total over an actor holding grants', () => {
    const token = serviceActor({ id: 'svc-1', orgId: 'acme', permissions: ['post:publish'] });
    expect(hasScope(token, 'tenancy:cross')).toBe(false);
    expect(actorLabel(token)).toBe('service:svc-1@acme');
    expect(isAnonymous(token)).toBe(false);
  });
});

// `permissions` is REQUIRED on `Actor`, exactly as `roles` and `scopes` are, and optional on
// `ActorInit`, where `build()` defaults it. That pairing is what makes the field total: every
// reader — `@ultimat3/policy`'s grant index above all — gets a list rather than a maybe-list, and
// an actor assembled by hand cannot omit the one field that decides what it may do.
// `@ts-expect-error` IS the assertion; it stops compiling the day the field goes optional.
describe('the grant list is required on an actor and optional on its init', () => {
  test('an actor literal that omits it is refused where it is written', () => {
    // @ts-expect-error `permissions` is required — `roles` and `scopes` are, and it is their peer.
    const handBuilt: Actor = { kind: 'user', id: 'ada', roles: [], scopes: [] };
    expect(handBuilt.id).toBe('ada');
  });

  test('an init that omits it is accepted, and the builder supplies the empty list', () => {
    const init: ActorInit = { id: 'ada' };
    expect(userActor(init).permissions).toEqual([]);
  });
});
