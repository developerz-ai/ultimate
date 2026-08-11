import { describe, expect, test } from 'bun:test';
import {
  actorFact,
  actorLabel,
  agentActor,
  anonymousActor,
  hasRole,
  hasScope,
  isAnonymous,
  userActor,
  withFacts,
} from './actor';
import { createContext, runWithContext, useContext, withChildContext } from './context';

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
