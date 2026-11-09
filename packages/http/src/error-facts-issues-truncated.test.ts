// `issuesTruncated` on the problem document: validation stops at `MAX_ISSUES`, and a client that
// renders `issues` INSTEAD of `cause` must be told the list is a prefix — on an action's refusal
// and a query's alike, which both put the mark on `meta.issuesTruncated`.

import { describe, expect, test } from 'bun:test';
import { UltimateError } from '@ultimat3/core';
import { toProblem } from './error-facts';

const issues = [
  { path: 'ids[0]', expected: 'number', received: '', message: 'expected a number' },
] as const;

/** The shape action's `InputInvalidError` and query's `QueryInputInvalidError` both produce. */
const refusal = (subject: string, meta: unknown, code = 'X_INPUT_INVALID'): unknown =>
  Object.assign(
    new UltimateError({ code, cause: `input for ${subject} failed validation`, fix: 'f' }),
    { meta },
  );

describe('toProblem carries the truncation mark', () => {
  test('an action and a query refusal cut at MAX_ISSUES both say so at the top level', () => {
    for (const subject of ['action "createPost"', 'query "orgFeed"']) {
      const problem = toProblem(refusal(subject, { issues, issuesTruncated: true }));
      expect(problem.issues).toEqual([...issues]);
      expect(problem.issuesTruncated).toBe(true);
      expect(JSON.parse(JSON.stringify(problem)).issuesTruncated).toBe(true);
    }
  });

  test('a whole list carries no mark at all — absent, never false', () => {
    const problem = toProblem(refusal('action "createPost"', { issues }));
    expect('issuesTruncated' in problem).toBe(false);
  });

  test('a mark with no carried list is dropped: it qualifies a list the document does not hold', () => {
    expect('issuesTruncated' in toProblem(refusal('q', { issuesTruncated: true }))).toBe(false);
    const malformed = { issues: [{ path: 1 }], issuesTruncated: true };
    expect('issuesTruncated' in toProblem(refusal('q', malformed))).toBe(false);
  });

  test('only a literal true marks it', () => {
    for (const mark of ['true', 1, {}, null]) {
      const problem = toProblem(refusal('q', { issues, issuesTruncated: mark }));
      expect('issuesTruncated' in problem).toBe(false);
    }
  });

  test('an unclassified 5xx drops the mark with the list', () => {
    const problem = toProblem(
      refusal('q', { issues, issuesTruncated: true }, 'X_SOMETHING_NOBODY_MAPPED'),
    );
    expect('issues' in problem).toBe(false);
    expect('issuesTruncated' in problem).toBe(false);
  });
});
