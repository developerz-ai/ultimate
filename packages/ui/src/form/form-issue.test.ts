// The two readers of a rejection, and the format each one has to survive. The wire carries no
// structured issue list today, so the cause-line reader is the bridge — and it is pinned against
// the exact string `@ultimat3/action`'s `InputInvalidError` mints.

import { describe, expect, test } from 'bun:test';
import { issuesFromRejection, issuesFromValidation } from './form-issue';

describe('issuesFromValidation', () => {
  test('a passing result has no issues — the absence is not an empty failure', () => {
    expect(issuesFromValidation({ value: { title: 'ok' } })).toEqual([]);
  });

  test('a nested path is flattened to the grammar the control names', () => {
    const issues = issuesFromValidation({
      issues: [{ message: 'expected number', path: ['items', 2, 'price'] }],
    });
    expect(issues).toEqual([
      { path: 'items[2].price', message: 'expected number', code: undefined },
    ]);
  });

  test('an issue with no path names the form, never a field called ""', () => {
    expect(issuesFromValidation({ issues: [{ message: 'at least one item' }] })).toEqual([
      { path: '', message: 'at least one item', code: undefined },
    ]);
  });
});

describe('issuesFromRejection', () => {
  /** What `ValidationFailedError` puts in `meta` — the structured path, when one survives. */
  test('reads the structured issue list a rejection carries in meta', () => {
    const issues = issuesFromRejection({
      code: 'X_VALIDATION_FAILED',
      cause: 'items[2].price: expected number',
      meta: {
        issues: [
          { path: 'items[2].price', expected: 'number', received: '', message: 'expected number' },
        ],
      },
    });
    expect(issues).toEqual([
      { path: 'items[2].price', message: 'expected number', code: 'X_VALIDATION_FAILED' },
    ]);
  });

  /**
   * The exact cause `@ultimat3/action`'s `InputInvalidError` builds:
   * `input for action "<name>" failed validation: ` + `formatIssues(...).join('; ')`.
   */
  test('reads the cause line X_INPUT_INVALID carries, prefix and all', () => {
    const issues = issuesFromRejection({
      code: 'X_INPUT_INVALID',
      cause:
        'input for action "createPost" failed validation: title: too short; items[2].price: expected number',
    });
    expect(issues).toEqual([
      { path: 'title', message: 'too short', code: 'X_INPUT_INVALID' },
      { path: 'items[2].price', message: 'expected number', code: 'X_INPUT_INVALID' },
    ]);
  });

  test('reads the same line off a parsed problem+json body, which carries no meta at all', () => {
    const issues = issuesFromRejection({
      code: 'X_VALIDATION_FAILED',
      detail: 'title: too short',
      cause: 'title: too short',
    });
    expect(issues).toEqual([{ path: 'title', message: 'too short', code: 'X_VALIDATION_FAILED' }]);
  });

  test('a fragment whose head is not a field path stays whole, at the form', () => {
    const issues = issuesFromRejection({
      code: 'X_INPUT_INVALID',
      cause: 'input for action "x" failed validation: expected one of: draft, live',
      // Bug-compatible on purpose: a message holding `: ` must not mint a field nobody declared.
    });
    expect(issues).toEqual([
      { path: '', message: 'expected one of: draft, live', code: 'X_INPUT_INVALID' },
    ]);
  });

  test('a refusal that is not a validation failure is one form-level issue, never dropped', () => {
    expect(
      issuesFromRejection({ code: 'X_FORBIDDEN', cause: 'policy "post:create" denied' }),
    ).toEqual([{ path: '', message: 'policy "post:create" denied', code: 'X_FORBIDDEN' }]);
  });

  test('a throwable the framework did not build still produces an issue', () => {
    const issues = issuesFromRejection(new TypeError('Failed to fetch'));
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toBe('');
    expect(issues[0]?.message.length).toBeGreaterThan(0);
  });

  test('a rejection with nothing readable on it is still surfaced', () => {
    for (const value of [undefined, null, 'boom', 42]) {
      const issues = issuesFromRejection(value);
      expect(issues).toHaveLength(1);
      expect(issues[0]?.path).toBe('');
    }
  });
});
