// The three renderings of one throwable, pinned together: the normalised facts, the RFC-9457
// document and the terminal lines. Status decisions are `error-map.test.ts`'s — a split this
// file exists because the two answer different questions about the same error.
import { describe, expect, test } from 'bun:test';
import { ERROR_DOCS_URL, UltimateError } from '@ultimat3/core';
import { factsOf, renderErrorLines, toProblem } from './error-facts';
import { bodyInvalid, forbidden, routeNotFound } from './errors';
import { rateLimited } from './rate-limit-errors';

describe('factsOf', () => {
  test('keeps code, cause and fix from an UltimateError', () => {
    const facts = factsOf(routeNotFound('GET', '/missing'));
    expect(facts.code).toBe('X_ROUTE_NOT_FOUND');
    expect(facts.cause).toContain('GET /missing');
    expect(facts.fix).toContain('x routes list');
    expect(facts.status).toBe(404);
    expect(facts.docs).toBe(ERROR_DOCS_URL);
  });

  test('titles a borrowed code from its owning package, without repeating the code', () => {
    // `X_FORBIDDEN` is policy's and `X_UNAUTHENTICATED` is auth's, so http holds no title for
    // either. Reading `message` instead once produced `X_FORBIDDEN: policy denied this actor — …`
    // as the *title*, which `renderErrorLines` then printed with the code a second time.
    const facts = factsOf(forbidden('/x', 'not an owner'));
    expect(facts.code).toBe('X_FORBIDDEN');
    expect(facts.title).not.toContain('X_FORBIDDEN');
    expect(facts.title).not.toContain('not an owner');
    expect(renderErrorLines(forbidden('/x', 'not an owner')).split('\n')[0]).toBe(
      `X_FORBIDDEN: ${facts.title}`,
    );
  });

  test('gives a foreign throwable a code and a fix too', () => {
    const facts = factsOf(new TypeError('x is not a function'));
    expect(facts.code).toBe('X_INTERNAL');
    expect(facts.status).toBe(500);
    expect(facts.fix.length).toBeGreaterThan(0);
  });

  test('renders the same three lines the terminal prints', () => {
    const lines = renderErrorLines(rateLimited('actor:1', 30)).split('\n');
    expect(lines[0]).toStartWith('X_RATE_LIMITED:');
    expect(lines[1]?.trim()).toStartWith('cause:');
    expect(lines[2]?.trim()).toStartWith('fix:');
  });
});

describe('toProblem', () => {
  test('is RFC-9457 shaped and carries the framework contract', () => {
    const document = toProblem(bodyInvalid('/posts', ['title: required']), {
      instance: '/posts',
      requestId: 'req-1',
    });
    expect(document.status).toBe(422);
    // The value itself is `problem-type.test.ts`'s subject; here it is one member of the shape.
    expect(document.type).toBe('urn:ultimate:error:X_BODY_INVALID');
    expect(document.detail).toContain('title: required');
    expect(document.code).toBe('X_BODY_INVALID');
    expect(document.fix).toContain('x routes --json');
    expect(document.instance).toBe('/posts');
    expect(document.requestId).toBe('req-1');
  });

  test('forbidden denials stay safe to log', () => {
    const document = toProblem(forbidden('/posts/1', 'actor does not own post'));
    expect(document.status).toBe(403);
    expect(document.cause).toContain('actor does not own post');
  });
});

// `factsOf` is the framework's universal normaliser: `pipeline.ts` hands it every throwable a
// request produced, including whatever an app's handler threw. The last fallback rendered that
// value with `String()`, which runs its own `toString` — so the throwable that reached the 500
// path took the 500 renderer with it and the server had nothing left to answer with.
describe('factsOf over a throwable it does not control', () => {
  const hostile = (): ReadonlyMap<string, unknown> =>
    new Map<string, unknown>([
      [
        'a hostile toString',
        {
          toString: () => {
            throw new Error('gotcha');
          },
        },
      ],
      ['a null-prototype object', Object.create(null)],
    ]);

  for (const [label, value] of hostile()) {
    test(`still answers X_INTERNAL for ${label}`, () => {
      let facts: ReturnType<typeof factsOf> | undefined;
      expect(() => {
        facts = factsOf(value);
      }).not.toThrow();
      expect(facts?.code).toBe('X_INTERNAL');
      expect(facts?.status).toBe(500);
      expect(facts?.cause.length).toBeGreaterThan(0);
    });
  }

  test('a throwable carrying its own strings is untouched', () => {
    expect(factsOf({ code: 'X_INTERNAL', cause: 'a', fix: 'b' }).cause).toBe('a');
    expect(factsOf(new TypeError('x is not a function')).cause).toBe('x is not a function');
  });
});

describe('the fix line every uncoded throwable gets', () => {
  // Axiom 4, on the path where the reader has the least context. It used to name
  // `x logs tail --json`, which is in `PLANNED_COMMANDS` and exits `X_NOT_IMPLEMENTED` — so the
  // one instruction an unhandled `TypeError` gave the reader failed when they ran it. The
  // `errors` verify step checks that a fix NAMES a command, never that the command exists.
  test('names a command this build ships, not a planned one', () => {
    const facts = factsOf(new TypeError('undefined is not a function'));
    expect(facts.fix).not.toContain('x logs');
    expect(facts.fix).toContain('x errors explain X_INTERNAL --json');
  });
});

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
        fix: 'x actions describe createPost --json  # prints the expected input schema',
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
    // The typed client bounds it at `MAX_WIRE_ISSUES` (`packages/action/src/wire-issues.ts`) and
    // drops anything longer, so an oversized list is a body that costs the wire and answers
    // nothing. Refused HERE, where the response is this package's business.
    const many = Array.from({ length: 101 }, (_, at) => ({
      path: `f${at}`,
      expected: 'string',
      received: '',
      message: 'expected a string',
    }));
    expect('issues' in toProblem(withMeta('X_BODY_INVALID', { issues: many }))).toBe(false);
    // The bound itself is inclusive: a hundred is a plausible form.
    const hundred = many.slice(0, 100);
    expect(toProblem(withMeta('X_BODY_INVALID', { issues: hundred })).issues).toHaveLength(100);
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
