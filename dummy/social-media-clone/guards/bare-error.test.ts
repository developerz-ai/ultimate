// The rule, driven directly. Failure case first: a guard whose rule silently stopped matching is
// a green gate over the convention it was written to enforce.

import { expect, unitTest } from '@ultimat3/testing';
import { bareThrows } from './bare-error';

const file = (source: string) => [{ path: 'apps/web/app/post/repo.ts', source }];

unitTest('a bare throw is refused, and the finding names the line', () => {
  const findings = bareThrows(file("const x = 1;\nthrow new Error('no post');"));
  expect(findings).toHaveLength(1);
  expect(findings[0]?.code).toBe('X_BARE_ERROR');
  expect(findings[0]?.cause).toContain(':2');
});

unitTest('TypeError and RangeError are the same rule', () => {
  expect(bareThrows(file("throw new TypeError('x');"))).toHaveLength(1);
  expect(bareThrows(file("throw new RangeError('x');"))).toHaveLength(1);
});

unitTest('an UltimateError subclass is what the rule asks for', () => {
  expect(bareThrows(file('throw new PostError(missingPost(id));'))).toEqual([]);
});

unitTest('a bare Error that is INPUT is not a verdict', () => {
  expect(bareThrows(file("controller.abort(new Error('cancelled'));"))).toEqual([]);
  expect(bareThrows(file("// throw new Error('x');"))).toEqual([]);
});
