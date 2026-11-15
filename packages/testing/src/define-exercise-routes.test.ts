// A route `load`'s entry in `defineExercise(…, { routes })`: params, actor, ceiling, an `empty` why
// or `off` — each reason stated, each pattern a route the app registers.

import { describe, expect, test } from 'bun:test';
import { userActor } from '@ultimat3/core';
import { defineExercise } from './define-exercise';
import { assertRoutesKnown } from './define-exercise-routes';
import { testName } from './test-types';

const codeOf = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    return (error as { readonly code?: string }).code ?? 'uncoded';
  }
  return 'no refusal';
};

describe(testName('unit', 'defineExercise routes'), () => {
  test('each route entry is kept by its URL pattern', () => {
    const owner = userActor({ id: 'owner', roles: ['owner'] });
    const declared = defineExercise(
      {},
      {
        routes: {
          '/posts/:id': { params: { id: 'p-1' }, actor: owner },
          '/about': { empty: 'renders a static page: no read to measure' },
          '/admin': { off: 'served by the admin package, measured there' },
        },
      },
    );
    expect(declared.routes?.get('/posts/:id')).toEqual({ params: { id: 'p-1' }, actor: owner });
    expect([...(declared.routes?.keys() ?? [])]).toEqual(['/posts/:id', '/about', '/admin']);
  });

  test('a blank off, empty or ceiling why is refused at the declaration', () => {
    expect(codeOf(() => defineExercise({}, { routes: { '/a': { off: ' ' } } }))).toBe(
      'X_CONTRACT_EXERCISE_UNDECLARED',
    );
    expect(codeOf(() => defineExercise({}, { routes: { '/a': { empty: '' } } }))).toBe(
      'X_CONTRACT_EXERCISE_UNDECLARED',
    );
    expect(
      codeOf(() => defineExercise({}, { routes: { '/a': { statements: { max: 9, why: '' } } } })),
    ).toBe('X_CONTRACT_EXERCISE_UNDECLARED');
  });

  test('a primitive’s blank empty why is refused too', () => {
    expect(codeOf(() => defineExercise({ listPosts: { empty: '  ' } }))).toBe(
      'X_CONTRACT_EXERCISE_UNDECLARED',
    );
  });

  test('a pattern no route registers is X_DECLARATION_UNKNOWN, naming the registered ones', () => {
    const declared = defineExercise({}, { routes: { '/post/:id': { params: { id: 'x' } } } });
    expect(codeOf(() => assertRoutesKnown(declared, ['/posts/:id']))).toBe('X_DECLARATION_UNKNOWN');
    expect(codeOf(() => assertRoutesKnown(declared, ['/post/:id']))).toBe('no refusal');
    expect(codeOf(() => assertRoutesKnown(undefined, []))).toBe('no refusal');
  });
});
