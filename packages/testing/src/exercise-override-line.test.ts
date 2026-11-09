// The paste line is TypeScript that compiles: the actor by its grants through `testActor`, each id
// field as the seeded row the pass bound, and nothing in angle brackets outside a string literal.

import { describe, expect, test } from 'bun:test';
import { overrideLine, UNBOUND_ID } from './exercise-override-line';
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
});
