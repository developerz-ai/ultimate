// A hostile search string against a read: 10k invalid items must cost a bounded refusal, carry
// the per-field list a form binds to, and say the list is a prefix rather than the whole answer.

import { describe, expect, test } from 'bun:test';
import { ctxOf, userActor } from '@ultimat3/core';
import { allow } from '@ultimat3/policy';
import { MAX_ISSUES, t } from '@ultimat3/schema';
import { QueryInputInvalidError } from './errors';
import { query } from './query';
import { runQuery } from './read';
import { from } from './source';

const target = query({
  input: t.object({ ids: t.array(t.number) }),
  policy: allow(),
  sql: () => from<{ id: string }>('rows', async () => []),
}).named('largeRefusal');

const refusalOf = async (raw: unknown): Promise<QueryInputInvalidError> => {
  const failure = await runQuery(target, raw as never, {
    ctx: ctxOf({ actor: userActor({ id: 'u-1' }) }),
  }).catch((error: unknown) => error);
  if (!(failure instanceof QueryInputInvalidError)) {
    return expect.unreachable(`expected X_INPUT_INVALID, got ${typeof failure}`);
  }
  return failure;
};

describe('a 10k-item invalid read input', () => {
  test('refuses with at most MAX_ISSUES issues, marked truncated, in a bounded document', async () => {
    const ids = Array.from({ length: 10_000 }, () => 'x');

    const refusal = await refusalOf({ ids });

    expect(refusal.code).toBe('X_INPUT_INVALID');
    expect(refusal.issues).toHaveLength(MAX_ISSUES);
    expect(refusal.issuesTruncated).toBe(true);
    expect(refusal.meta?.['issuesTruncated']).toBe(true);
    expect(refusal.meta?.['issues']).toEqual(refusal.issues);
    expect(JSON.stringify(refusal.toJSON()).length).toBeLessThan(64 * 1024);
  });

  test('a short list is whole: issues addressed by path, no truncation mark', async () => {
    const refusal = await refusalOf({ ids: [1, 'x'] });

    expect(refusal.issues?.map((issue) => issue.path)).toEqual(['ids[1]']);
    expect(refusal.issuesTruncated).toBe(false);
    expect(refusal.meta?.['issuesTruncated']).toBeUndefined();
    // The prose line is the rendered list, as it always was.
    expect(refusal.cause).toContain('ids[1]:');
  });
});
