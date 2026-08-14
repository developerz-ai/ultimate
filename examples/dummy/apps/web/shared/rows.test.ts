// Two detail routes hand their whole page to `oneRow`, so its empty case IS the app's 404. A
// helper that returned `undefined` instead would put it in a `<title>` rather than a status code.

import { expect, unitTest } from '@ultimat3/testing';
import { oneRow } from './rows';

unitTest('hands back the row a bounded read answered with', () => {
  expect(oneRow([{ slug: 'hello' }], 'hello')).toEqual({ slug: 'hello' });
});

unitTest('an empty answer is X_NOT_FOUND, naming what was asked for', () => {
  // Never `undefined`: a detail route has no second branch, and the read already applied the
  // policy — so "no rows" is the answer, not a missing one.
  expect(() => oneRow([], 'missing-slug')).toThrow(/X_NOT_FOUND/);
  expect(() => oneRow([], 'missing-slug')).toThrow(/"missing-slug"/);
});

unitTest('a read that answered more than one row still renders the first', () => {
  // `limit(1)` is the read's job; the page renders one post either way rather than throwing on
  // a query whose bound someone widened.
  expect(oneRow([{ slug: 'a' }, { slug: 'b' }], 'a')).toEqual({ slug: 'a' });
});
