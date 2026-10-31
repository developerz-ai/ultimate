// `query({ download })` in-process: what the declaration refuses, that every rows projection is
// one refusal, that the in-process call and the mint both run the read's policy, and what a token
// binds — the query, the input, the clock and the minting actor.

import { describe, expect, test } from 'bun:test';
import { ctxOf, frozenClock, isUltimateError, userActor } from '@ultimat3/core';
import type { Actor } from '@ultimat3/policy';
import { can } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import type { DownloadQuery, DownloadQueryDef } from './download';
import { serveDownloadFile } from './download';
import { query, sourceFor } from './query';
import { describeSql } from './sql';

const RUN = '00000000-0000-4000-8000-000000000001';
const OTHER_RUN = '00000000-0000-4000-8000-000000000002';
const Input = t.object({ runId: t.uuid });
const BYTES = new TextEncoder().encode('0123456789');

const viewer = (id = 'u1', permissions = ['recording:read']): Actor =>
  userActor({ id, orgId: 'o1', permissions });

const codeOf = async (run: () => unknown): Promise<string> => {
  try {
    await run();
  } catch (error) {
    return isUltimateError(error) ? error.code : `not-coded: ${String(error)}`;
  }
  return 'resolved';
};

/** One download per test; `seen` records who `handle` ran as and what it was handed. */
function recording(seen: { actor?: string; input?: unknown } = {}, expiresInMs?: number) {
  return query({
    input: Input,
    policy: can<{ runId: string }>('recording:read', ({ input }) => input.runId !== OTHER_RUN),
    download: {
      ...(expiresInMs === undefined ? {} : { expiresInMs }),
      async handle({ input, ctx }) {
        seen.actor = ctx.actor.id;
        seen.input = input;
        return { body: BYTES, contentType: 'video/mp4', filename: `${input.runId}.mp4` };
      },
    },
  }).named('runRecording');
}

const tokenOf = (url: string): string => new URL(url, 'http://x').searchParams.get('_token') ?? '';

describe('the declaration', () => {
  test('a rows option beside download is X_QUERY_DOWNLOAD_INVALID, not a second answer', async () => {
    const handle = async () => ({ body: BYTES, contentType: 'video/mp4', filename: 'a.mp4' });
    for (const extra of [{ sql: () => [] }, { live: true }, { single: true }, { cache: {} }]) {
      const def = { input: Input, policy: can('recording:read'), download: { handle }, ...extra };
      expect(await codeOf(() => query(def as unknown as DownloadQueryDef<typeof Input>))).toBe(
        'X_QUERY_DOWNLOAD_INVALID',
      );
    }
  });

  test('a handle that is not a function, or an expiry outside 1 s … 1 h, is refused', async () => {
    const declare = (download: unknown) => () =>
      query({ input: Input, policy: can('recording:read'), download } as DownloadQueryDef<
        typeof Input
      >);
    expect(await codeOf(declare({ handle: 'no' }))).toBe('X_QUERY_DOWNLOAD_INVALID');
    for (const expiresInMs of [0, 999, 3_600_001, 1.5e3 + 0.5, Number.NaN, Infinity]) {
      const handle = async () => ({ body: BYTES, contentType: 'x/y', filename: 'f' });
      expect(await codeOf(declare({ expiresInMs, handle }))).toBe('X_QUERY_DOWNLOAD_INVALID');
    }
  });

  test('an input field named _token is refused where it is written', async () => {
    const handle = async () => ({ body: BYTES, contentType: 'x/y', filename: 'f' });
    const def = { input: t.object({ _token: t.string }), policy: can('recording:read') };
    expect(await codeOf(() => query({ ...def, download: { handle } }))).toBe(
      'X_QUERY_INPUT_UNENCODABLE',
    );
  });

  test('it is a query: kind, a descriptor that says download, no live', () => {
    const target = recording();
    expect(target.kind).toBe('query');
    expect(target.download).toBe(true);
    expect(target.describe()).toMatchObject({
      name: 'runRecording',
      live: false,
      download: true,
      capability: 'recording:read',
    });
  });
});

describe('rows are refused on every projection, by one line', () => {
  test('live, page, as and sourceFor are X_QUERY_DOWNLOAD_ONLY', async () => {
    const target = recording();
    const as = viewer();
    expect(await codeOf(() => target.live({ runId: RUN }))).toBe('X_QUERY_DOWNLOAD_ONLY');
    expect(await codeOf(() => target.page({ runId: RUN }, { first: 1 }))).toBe(
      'X_QUERY_DOWNLOAD_ONLY',
    );
    expect(await codeOf(() => target.as(as, { runId: RUN }))).toBe('X_QUERY_DOWNLOAD_ONLY');
    expect(
      await codeOf(() => sourceFor(target, { runId: RUN }, { ctx: ctxOf({ actor: as }) })),
    ).toBe('X_QUERY_DOWNLOAD_ONLY');
  });

  test('the dashboard listing renders no SQL for it, sample or not', async () => {
    const listed = await describeSql({ runRecording: { runId: RUN } }, [recording()]);
    expect(listed).toEqual([{ query: 'runRecording', live: false, sql: null }]);
  });
});

describe('the in-process call and the mint run the read’s policy', () => {
  test('the file, as the caller, for an admitted input', async () => {
    const seen: { actor?: string } = {};
    const file = await recording(seen)({ runId: RUN }, { ctx: ctxOf({ actor: viewer('u7') }) });
    expect(file.body).toBe(BYTES);
    expect(seen.actor).toBe('u7');
  });

  test('a denied caller gets the policy’s refusal from the call and from url()', async () => {
    const target = recording();
    const nobody = { ctx: ctxOf() };
    const stranger = { ctx: ctxOf({ actor: viewer('u2', []) }) };
    expect(await codeOf(() => target({ runId: RUN }, nobody))).toBe('X_UNAUTHENTICATED');
    expect(await codeOf(() => target.url({ runId: RUN }, stranger))).toBe('X_FORBIDDEN');
    // The predicate's own clause: the input decides, as on any read.
    const allowed = { ctx: ctxOf({ actor: viewer() }) };
    expect(await codeOf(() => target.url({ runId: OTHER_RUN }, allowed))).toBe('X_FORBIDDEN');
  });

  test('url() is the route’s path, the input, the token and an ISO expiry on the ctx clock', async () => {
    const clock = frozenClock('2026-10-31T10:00:00.000Z');
    const minted = await recording({}, 60_000).url(
      { runId: RUN },
      { ctx: ctxOf({ actor: viewer(), clock }) },
    );
    expect(minted.url).toStartWith(`/_x/query/run-recording?runId=${RUN}&_token=x1.`);
    expect(minted.expiresAt).toBe('2026-10-31T10:01:00.000Z');
  });
});

describe('what a token binds', () => {
  async function minted(target: DownloadQuery<typeof Input>, at = '2026-10-31T10:00:00.000Z') {
    const clock = frozenClock(at);
    const { url } = await target.url(
      { runId: RUN },
      { ctx: ctxOf({ actor: viewer('u9'), clock }) },
    );
    return { token: tokenOf(url), clock };
  }
  const serve = (
    target: DownloadQuery<typeof Input>,
    input: unknown,
    token: string,
    clock = frozenClock('2026-10-31T10:00:30.000Z'),
  ) => serveDownloadFile(target, input, token, { ctx: ctxOf({ clock }) });

  test('the file, as the MINTING actor, with no session on the serve', async () => {
    const seen: { actor?: string; input?: unknown } = {};
    const target = recording(seen);
    const { token } = await minted(target);
    const file = await serve(target, { runId: RUN }, token);
    expect(file.contentType).toBe('video/mp4');
    expect(seen).toEqual({ actor: 'u9', input: { runId: RUN } });
  });

  test('past its expiry it is X_QUERY_DOWNLOAD_TOKEN_EXPIRED', async () => {
    const target = recording({}, 60_000);
    const { token, clock } = await minted(target);
    clock.advance(60_000);
    expect(await codeOf(() => serve(target, { runId: RUN }, token, clock))).toBe(
      'X_QUERY_DOWNLOAD_TOKEN_EXPIRED',
    );
  });

  test('another input, another query, a forged or truncated token are all INVALID', async () => {
    const target = recording();
    const { token } = await minted(target);
    const other = recording().named('runScreenshot');
    // A character mid-ciphertext: every one of its bits is significant, unlike the last one's.
    const at = token.length - 8;
    const flipped = `${token.slice(0, at)}${token[at] === 'A' ? 'B' : 'A'}${token.slice(at + 1)}`;
    for (const [what, run] of [
      ['other input', () => serve(target, { runId: OTHER_RUN }, token)],
      ['other query', () => serve(other, { runId: RUN }, token)],
      ['one character flipped', () => serve(target, { runId: RUN }, flipped)],
      ['truncated', () => serve(target, { runId: RUN }, token.slice(0, 40))],
      ['not a token', () => serve(target, { runId: RUN }, 'hello')],
    ] as const) {
      expect([what, await codeOf(run)]).toEqual([what, 'X_QUERY_DOWNLOAD_TOKEN_INVALID']);
    }
  });

  test('an expired FORGERY is answered as a forgery: the seal is checked first', async () => {
    const target = recording({}, 60_000);
    const { token } = await minted(target);
    const late = frozenClock('2026-11-30T00:00:00.000Z');
    expect(await codeOf(() => serve(target, { runId: RUN }, `${token}x`, late))).toBe(
      'X_QUERY_DOWNLOAD_TOKEN_INVALID',
    );
  });

  test('the token does not carry the actor in the clear', async () => {
    const target = recording();
    const clock = frozenClock('2026-10-31T10:00:00.000Z');
    const actor = userActor({ id: 'secret-user', orgId: 'o1', permissions: ['recording:read'] });
    const { url } = await target.url({ runId: RUN }, { ctx: ctxOf({ actor, clock }) });
    // Sealed, not signed: the claims are ciphertext, so neither the id nor a grant is readable.
    expect(decodeURIComponent(url)).not.toContain('secret-user');
    expect(tokenOf(url)).not.toContain('recording');
    expect(tokenOf(url)).toMatch(/^x1\.[0-9a-f]{16}\./);
  });
});
