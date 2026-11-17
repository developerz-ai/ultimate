// The paste line is TypeScript that compiles: the actor by its grants through `testActor`, each id
// field as the seeded row the pass bound, and nothing in angle brackets outside a string literal.

import { describe, expect, test } from 'bun:test';
import type { ActorFactMap } from '@ultimat3/core';
import { userActor } from '@ultimat3/core';
import type { IdLookup } from './exercise-input';
import { actorHintOf, hintFor, overrideLine, UNBOUND_ID } from './exercise-override-line';
import { testName } from './test-types';

const ID = '0b6f4c1e-7d2a-4c55-9a51-3f0c8e2b9d10';

describe(testName('unit', 'overrideLine'), () => {
  test('a role actor is a testActor call, and the line names its one import', () => {
    expect(
      overrideLine('publishPost', ['postId'], {
        actor: { name: 'editor', roles: ['editor'], permissions: [] },
        ids: { postId: ID },
      }),
    ).toBe(
      `publishPost: { actor: testActor("editor", { roles: ["editor"] }).actor, input: (drawn) => ({ ...drawn, postId: "${ID}" }) }, // testActor: @ultimat3/policy`,
    );
  });

  test('signed out is actor: null; a declared actor is left to the entry; quotes are escaped', () => {
    expect(overrideLine('a', [], { actor: null })).toBe(
      'a: { actor: null, input: (drawn) => ({ ...drawn }) },',
    );
    expect(overrideLine('kind:b', ['post-id'], {})).toBe(
      `"kind:b": { input: (drawn) => ({ ...drawn, "post-id": "${UNBOUND_ID}" }) },`,
    );
    expect(
      overrideLine('c', [], { actor: { name: "o'neil", roles: [], permissions: ['x:y'] } }),
    ).toContain(`testActor("o'neil", { permissions: ["x:y"] }).actor`);
  });

  test('the actor slot never holds a bare <…> placeholder', () => {
    for (const actor of [undefined, null, { name: 'r', roles: ['r'], permissions: [] }]) {
      expect(overrideLine('d', ['postId'], { actor })).not.toMatch(/actor: </);
    }
  });

  test('a newline, a line separator or a quote in a value still parses as TypeScript', () => {
    const parse = new Bun.Transpiler({ loader: 'ts' });
    for (const odd of ['a\nb', 'a\u2028b', 'a\u2029b', "it's", 'back\\slash']) {
      const line = overrideLine('e', ['postId'], {
        actor: { name: odd, roles: [odd], permissions: [odd] },
        ids: { postId: odd },
      });
      expect(() => parse.transformSync(`const entries = {\n${line}\n};`)).not.toThrow();
      expect(line).not.toContain('\n');
    }
  });

  // The saas scaffold's `sendReminder`: its entry declares a member in the generated org. The line
  // used to drop that actor (pasted: X_FORBIDDEN) and print the run's random tenant as `orgId`
  // (pasted: the next run's tenant differs, and its line asks for `<a real id>`).
  const ORG = '00000000-0000-4000-8000-000000000002';
  const member = userActor({ id: 'member', orgId: ORG, permissions: ['invoice:write'] });
  const pass = { kind: 'actor', actor: member, name: 'member' } as const;
  const tenantLookup =
    (tenant: string): IdLookup =>
    (key) =>
      key === 'orgId' ? { found: true, value: tenant, tenant: true } : undefined;
  const lineIn = (tenant: string, declared: Parameters<typeof actorHintOf>[1]) => {
    const hint = hintFor(actorHintOf(pass, declared), { id: ID, orgId: tenant }, [
      tenantLookup(tenant),
    ]);
    return overrideLine('sendReminder', ['orgId'], hint);
  };

  test('a declared actor is kept, and a tenant field is its declared org: the same every run', () => {
    const one = lineIn('7a1e0d4c-0000-4000-8000-00000000000a', { actor: member });
    const two = lineIn('3c9b2f11-0000-4000-8000-00000000000b', { actor: member });
    expect(one).toBe(two);
    expect(one).toBe(
      `sendReminder: { actor: userActor({ id: "member", orgId: "${ORG}", permissions: ["invoice:write"] }), input: (drawn) => ({ ...drawn, orgId: "${ORG}" }) }, // userActor: @ultimat3/core`,
    );
  });

  test('with no declared org a tenant field is left to the pass, which binds it every run', () => {
    const one = lineIn('7a1e0d4c-0000-4000-8000-00000000000a', undefined);
    expect(one).toBe(lineIn('3c9b2f11-0000-4000-8000-00000000000b', undefined));
    expect(one).not.toContain('orgId');
    expect(one).not.toContain(UNBOUND_ID);
  });

  test('a declared signed-out caller stays null; an unspellable one is left out', () => {
    expect(actorHintOf(pass, { actor: null })).toBeNull();
    const impersonated = {
      ...member,
      onBehalfOf: { actorKind: 'user', actorId: 'admin' },
    } as const;
    expect(actorHintOf(pass, { actor: impersonated })).toBeUndefined();
  });

  test('a spelled actor compiles', () => {
    const parse = new Bun.Transpiler({ loader: 'ts' });
    // An app's augmented facts; this package declares none, so the map arrives as parsed JSON.
    const facts = JSON.parse('{"plan":"pro","seats":3}') as ActorFactMap;
    const actor = userActor({ id: 'o"x', roles: ['r'], scopes: ['s'], facts, locale: 'en' });
    const line = overrideLine('f', [], hintFor(actorHintOf(pass, { actor }), {}, []));
    expect(line).toContain('facts: {"plan":"pro","seats":3}');
    expect(() => parse.transformSync(`const entries = {\n${line}\n};`)).not.toThrow();
  });
});
