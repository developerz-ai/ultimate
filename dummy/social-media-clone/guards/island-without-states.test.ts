// The rule, driven directly. Failure case first: a guard whose rule silently stopped matching is
// a green gate over the convention it was written to enforce.

import { expect, unitTest } from '@ultimat3/testing';
import { islandsWithoutStates, statesPathFor } from './island-without-states';

const ISLAND = 'apps/web/app/post/post-form.island.tsx';

unitTest('an island with no states file is refused, and the fix names the file to write', () => {
  const findings = islandsWithoutStates([ISLAND], []);
  expect(findings).toHaveLength(1);
  expect(findings[0]?.code).toBe('X_ISLAND_WITHOUT_STATES');
  expect(findings[0]?.at).toBe(ISLAND);
  expect(findings[0]?.fix).toContain('apps/web/app/post/post-form.island.states.ts');
  // The name `x shot --island` is given, not the path: a fix is pasted and run verbatim.
  expect(findings[0]?.fix).toContain('x shot --island post-form');
});

unitTest('the sibling states file satisfies it', () => {
  expect(islandsWithoutStates([ISLAND], [statesPathFor(ISLAND)])).toEqual([]);
});

// The states file is found by DERIVING its path, never by name: a states file for another island
// in the same directory answers for that island and not for this one.
unitTest('a states file for a different island in the same folder is not this one', () => {
  const other = 'apps/web/app/post/comment-box.island.states.ts';
  expect(islandsWithoutStates([ISLAND], [other])).toHaveLength(1);
});

unitTest('the derived path swaps the island suffix and nothing else', () => {
  expect(statesPathFor(ISLAND)).toBe('apps/web/app/post/post-form.island.states.ts');
});
