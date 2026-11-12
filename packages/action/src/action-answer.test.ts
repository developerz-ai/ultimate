// The flash's two halves: what the writer sends fits a cookie, and the reader trusts nothing the
// browser hands back, answers once, and only for the action it was asked about.

import { describe, expect, test } from 'bun:test';
import { runWithContext } from '@ultimat3/core';
import { asCtx, defineHttpConfig, requestContext } from '@ultimat3/http';
import { allow } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { action } from './action';
import type { ActionAnswer } from './action-answer';
import {
  ACTION_ANSWER_COOKIE,
  answerIssues,
  fitAnswer,
  parseActionAnswer,
  useActionAnswer,
} from './action-answer';

const config = defineHttpConfig({ rateLimit: { scope: 'process' } });

const named = (name: string) =>
  action({
    input: t.object({}),
    output: t.object({}),
    policy: allow(),
    handle: () => ({}),
  }).named(name);

const refusal: ActionAnswer = {
  action: 'createPost',
  outcome: 'refusal',
  code: 'X_INPUT_INVALID',
  issues: [{ path: 'title', rule: 'string.min', params: { min: 3 } }],
  truncated: false,
};

const withCookie = (value: string) =>
  requestContext({
    url: new URL('https://example.com/posts/new'),
    method: 'get',
    role: 'web',
    config,
    requestHeaders: { cookie: `${ACTION_ANSWER_COOKIE}=${encodeURIComponent(value)}` },
  });

describe('parseActionAnswer', () => {
  test('round-trips what the writer sends', () => {
    expect(parseActionAnswer(JSON.stringify(refusal))).toEqual(refusal);
  });

  test.each([
    ['not JSON', '{'],
    ['no action', JSON.stringify({ outcome: 'success' })],
    ['an unknown outcome', JSON.stringify({ action: 'a', outcome: 'maybe' })],
    ['a code that is not one', JSON.stringify({ action: 'a', outcome: 'refusal', code: '<b>' })],
    ['nothing at all', null],
  ])('%s reads as null', (_label, raw) => {
    expect(parseActionAnswer(raw)).toBeNull();
  });
});

describe('answerIssues', () => {
  test('keeps the path, the rule and its numbers — never the value or the prose', () => {
    const issues = answerIssues([
      {
        path: 'card',
        message: 'too short',
        received: '4242',
        rule: 'string.min',
        params: { min: 16 },
      },
      { message: 'no path' },
    ]);
    expect(issues).toEqual([{ path: 'card', rule: 'string.min', params: { min: 16 } }]);
  });
});

describe('fitAnswer', () => {
  test('drops whole issues to stay under a cookie, and says so', () => {
    const many = Array.from({ length: 200 }, (_, i) => ({ path: `field${i}`, rule: 'required' }));
    const fitted = fitAnswer({ ...refusal, issues: many });
    expect(fitted.outcome === 'refusal' && fitted.truncated).toBe(true);
    expect(encodeURIComponent(JSON.stringify(fitted)).length).toBeLessThanOrEqual(3000);
  });
});

describe('useActionAnswer', () => {
  test('answers the flash once and clears it', () => {
    const ctx = withCookie(JSON.stringify(refusal));
    expect(runWithContext(asCtx(ctx), () => useActionAnswer())).toEqual(refusal);
    expect(ctx.headers.getSetCookie().join('\n')).toContain(`${ACTION_ANSWER_COOKIE}=;`);
  });

  test("given an action, another action's answer is not this form's", () => {
    const ctx = withCookie(JSON.stringify(refusal));
    expect(runWithContext(asCtx(ctx), () => useActionAnswer(named('deletePost')))).toBeNull();
    expect(ctx.headers.getSetCookie()).toEqual([]);
    expect(runWithContext(asCtx(ctx), () => useActionAnswer(named('createPost')))).toEqual(refusal);
  });

  test('given a name, the same filter: a page that may not import the action names it', () => {
    const ctx = withCookie(JSON.stringify(refusal));
    expect(runWithContext(asCtx(ctx), () => useActionAnswer('deletePost'))).toBeNull();
    expect(ctx.headers.getSetCookie()).toEqual([]);
    expect(runWithContext(asCtx(ctx), () => useActionAnswer('createPost'))).toEqual(refusal);
  });
});
