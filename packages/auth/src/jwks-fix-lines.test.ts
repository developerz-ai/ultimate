// The three `curl` lines `jwks.ts` hands a reader, and the one value in them. `jwks_uri` comes out
// of the ISSUER's own discovery document, so it is remote text in a COMMAND position — `$(id)` and
// a backtick substitute before `curl` is reached at all. Split from `jwks.test.ts`, which answers
// what a signature check DOES, at the 500-line ceiling.
//
// A screened value is only half the contract: `curl -sS -m 5 <the provider jwks_uri>` carries no
// substitution AND is not a command — `<` opens a redirection — so the hostile cases assert PROSE
// and the absence of `curl`, never a placeholder inside one.

import { describe, expect, test } from 'bun:test';
import { frozenClock } from '@ultimat3/core';
import { AuthError } from './errors';
import { createJwksClient } from './jwks';

const clock = frozenClock(new Date('2026-08-16T12:00:00.000Z'));

const HOSTILE = 'https://op.test/$(id)/`id`/jwks';

/** The `fix:` of whatever this client refuses with, or a sentence naming what came back instead. */
const fixFor = async (jwksUri: string, doFetch: () => Promise<Response>): Promise<string> => {
  const keys = createJwksClient({ provider: 'test-op', jwksUri, clock, fetch: doFetch });
  const thrown = await keys.keyFor('k1', 'RS256').catch((error: unknown) => error);
  return thrown instanceof AuthError ? thrown.fix : `not-an-AuthError: ${typeof thrown}`;
};

const unreachable = async (): Promise<Response> => new Response('nope', { status: 503 });

describe('a jwks_uri the issuer supplied', () => {
  test('never reaches the fix line, on the status path or the rejection path', async () => {
    const rendered = [
      await fixFor(HOSTILE, unreachable),
      await fixFor(HOSTILE, async () => {
        throw new TypeError('connection refused');
      }),
    ];
    for (const fix of rendered) {
      expect(fix).not.toContain('$(');
      expect(fix).not.toContain('`');
      // Prose, and no command at all: a placeholder in an argument position is not runnable.
      expect(fix).not.toContain('curl');
      expect(fix).not.toContain('<the provider jwks_uri>');
      expect(fix).toBe(
        "fetch the jwks_uri from test-op's discovery document by hand — this one carries shell syntax, so no pasteable command can name it",
      );
    }
  });

  test('nor the third command in that file — the kid the published set does not hold', async () => {
    const empty = async (): Promise<Response> =>
      new Response(JSON.stringify({ keys: [] }), {
        headers: { 'content-type': 'application/json' },
      });
    const keys = createJwksClient({
      provider: 'test-op',
      jwksUri: HOSTILE,
      clock,
      fetch: empty,
    });
    const thrown = await keys.keyFor('k9', 'RS256').catch((error: unknown) => error);
    const fix = thrown instanceof AuthError ? thrown.fix : '';
    expect(thrown instanceof AuthError ? thrown.code : '').toBe('X_OAUTH_TOKEN_INVALID');
    expect(fix).not.toContain('$(');
    expect(fix).not.toContain('curl');
    expect(fix).toStartWith("fetch the jwks_uri from test-op's discovery document by hand");
    // The trailing instruction still travels — degrading the COMMAND must not lose the sentence.
    expect(fix).toEndWith('# then confirm the token was signed by this issuer');
  });

  test('an ordinary jwks_uri still travels, so the command still reproduces the failure', async () => {
    expect(await fixFor('https://op.test/.well-known/jwks.json', unreachable)).toBe(
      'curl -sS -m 5 https://op.test/.well-known/jwks.json',
    );
  });
});
