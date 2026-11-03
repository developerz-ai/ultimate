// Single responsibility: an issue's `rule` and `params` crossing `toProblem`, and nothing else
// of the issue riding with them. WHY: a translator keys a form message on `rule`, so the wire must
// carry it — and the carry is member by member, so a hostile one cannot smuggle a value out.

import { describe, expect, test } from 'bun:test';
import { UltimateError } from '@ultimat3/core';
import { toProblem } from './error-facts';

const rejected = (issues: readonly unknown[]): unknown =>
  Object.assign(new UltimateError({ code: 'X_BODY_INVALID', cause: 'c', fix: 'f' }), {
    meta: { issues },
  });

describe('toProblem carries an issue’s rule', () => {
  test('a string rule and scalar params round-trip', () => {
    const problem = toProblem(
      rejected([{ path: 'title', message: 'too short', rule: 'string.min', params: { min: 3 } }]),
    );
    expect(problem.issues?.[0]).toEqual({
      path: 'title',
      expected: 'too short',
      received: '',
      message: 'too short',
      rule: 'string.min',
      params: { min: 3 },
    });
  });

  test('a non-string rule is dropped, and a params holding a non-scalar is dropped whole', () => {
    const problem = toProblem(
      rejected([
        { path: 'a', message: 'm', rule: 42, params: { min: 1 } },
        { path: 'b', message: 'm', rule: 'string.max', params: { max: 2, value: { pan: '4111' } } },
      ]),
    );
    expect(problem.issues?.[0]).not.toHaveProperty('rule');
    expect(problem.issues?.[0]).not.toHaveProperty('params');
    expect(problem.issues?.[1]).toMatchObject({ rule: 'string.max' });
    expect(problem.issues?.[1]).not.toHaveProperty('params');
    expect(JSON.stringify(problem)).not.toContain('4111');
  });
});
