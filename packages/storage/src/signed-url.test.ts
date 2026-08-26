import { describe, expect, test } from 'bun:test';
import { frozenClock } from '@ultimat3/core';
import { buildSignedUrl, verifySignedUrl } from './signed-url';

const SECRET = 'test-signing-secret';
const KEY = 'org/org-1/avatars/a.png';
const START = '2026-07-26T12:00:00.000Z';

const putUrl = async (clock: ReturnType<typeof frozenClock>): Promise<string> =>
  buildSignedUrl({
    secret: SECRET,
    key: KEY,
    method: 'PUT',
    expiresInMs: 60_000,
    maxBytes: 1024,
    contentType: 'image/png',
    clock,
  });

describe('verifySignedUrl', () => {
  test('verifies before the expiry and fails after it', async () => {
    const clock = frozenClock(START);
    const url = await putUrl(clock);

    const fresh = await verifySignedUrl({ url, secret: SECRET, clock });
    expect(fresh.ok).toBe(true);
    expect(fresh.ok ? fresh.constraints.maxBytes : 0).toBe(1024);
    expect(fresh.ok ? fresh.constraints.key : '').toBe(KEY);

    clock.advance(59_999);
    expect((await verifySignedUrl({ url, secret: SECRET, clock })).ok).toBe(true);

    clock.advance(2);
    const stale = await verifySignedUrl({ url, secret: SECRET, clock });
    expect(stale.ok).toBe(false);
    expect(stale.ok ? '' : stale.reason).toBe('expired');
  });

  test('a different secret never verifies', async () => {
    const clock = frozenClock(START);
    const url = await putUrl(clock);
    const result = await verifySignedUrl({ url, secret: 'other-secret', clock });
    expect(result.ok ? '' : result.reason).toBe('signature-mismatch');
  });

  // The constraints are IN the canonical string, so a client cannot widen what it was granted.
  test('tampering with the key invalidates the signature', async () => {
    const clock = frozenClock(START);
    const url = await putUrl(clock);
    const tampered = url.replace('a.png', 'b.png');
    expect(tampered).not.toBe(url);
    const result = await verifySignedUrl({ url: tampered, secret: SECRET, clock });
    expect(result.ok ? '' : result.reason).toBe('signature-mismatch');
  });

  test('tampering with maxBytes invalidates the signature', async () => {
    const clock = frozenClock(START);
    const url = await putUrl(clock);
    const tampered = url.replace('x-max=1024', 'x-max=999999999');
    expect(tampered).not.toBe(url);
    const result = await verifySignedUrl({ url: tampered, secret: SECRET, clock });
    expect(result.ok ? '' : result.reason).toBe('signature-mismatch');
  });

  test('tampering with the content type invalidates the signature', async () => {
    const clock = frozenClock(START);
    const url = await putUrl(clock);
    const tampered = url.replace('x-ct=image%2Fpng', 'x-ct=text%2Fhtml');
    expect(tampered).not.toBe(url);
    const result = await verifySignedUrl({ url: tampered, secret: SECRET, clock });
    expect(result.ok ? '' : result.reason).toBe('signature-mismatch');
  });

  test('extending the expiry invalidates the signature', async () => {
    const clock = frozenClock(START);
    const url = await putUrl(clock);
    const granted = new URL(url, 'http://storage.invalid').searchParams.get('x-exp') ?? '';
    const tampered = url.replace(granted, String(Number(granted) + 86_400_000));
    const result = await verifySignedUrl({ url: tampered, secret: SECRET, clock });
    expect(result.ok ? '' : result.reason).toBe('signature-mismatch');
  });

  test('a URL outside the mounted base is malformed, not signature-checked', async () => {
    const clock = frozenClock(START);
    const url = await putUrl(clock);
    const result = await verifySignedUrl({ url, secret: SECRET, clock, baseUrl: '/elsewhere' });
    expect(result.ok ? '' : result.reason).toBe('malformed');
  });

  // The header's promise is that verification never throws. `decodeURIComponent('%ZZ')` is a bare
  // `URIError`, and the URL here is whatever the caller sent — it used to escape as an uncoded 500.
  test('a key segment that will not percent-decode is malformed, not a throw', async () => {
    const clock = frozenClock(START);
    const url = await putUrl(clock);
    for (const bad of ['%ZZ', '%', '%A', '%E0%A4%A']) {
      const tampered = url.replace('a.png', bad);
      const result = await verifySignedUrl({ url: tampered, secret: SECRET, clock });
      expect(result.ok).toBe(false);
      expect(result.ok ? '' : result.reason).toBe('malformed');
    }
  });

  test('a malformed escape anywhere in the key is refused, not just in the last segment', async () => {
    const clock = frozenClock(START);
    const url = await putUrl(clock);
    const tampered = url.replace('avatars', '%ZZ');
    const result = await verifySignedUrl({ url: tampered, secret: SECRET, clock });
    expect(result.ok ? '' : result.reason).toBe('malformed');
  });

  test('an absolute URL from a browser verifies identically', async () => {
    const clock = frozenClock(START);
    const url = await putUrl(clock);
    const absolute = `https://app.example.com${url}`;
    expect((await verifySignedUrl({ url: absolute, secret: SECRET, clock })).ok).toBe(true);
  });
});

/**
 * Absent and empty rendered to the SAME canonical string (`contentType ?? ''`), so appending
 * `&x-ct=` to a URL signed with no content type verified — and `acceptSignedUpload`'s
 * `unconstrained` refusal only fires on `undefined`, so the appended empty type turned a PUT that
 * bounds nothing into one that claims to bound something. Defence in depth, closed at the parse.
 */
describe('an empty content type is never the same as none', () => {
  const unconstrained = async (clock: ReturnType<typeof frozenClock>): Promise<string> =>
    await buildSignedUrl({
      secret: SECRET,
      key: KEY,
      method: 'PUT',
      expiresInMs: 60_000,
      clock,
    });

  test('appending &x-ct= to a URL signed with no content type does not verify', async () => {
    const clock = frozenClock(START);
    const url = await unconstrained(clock);
    expect((await verifySignedUrl({ url, secret: SECRET, clock })).ok).toBe(true);

    const forged = `${url}&x-ct=`;
    const verified = await verifySignedUrl({ url: forged, secret: SECRET, clock });
    expect(verified.ok).toBe(false);
    expect(verified.ok ? '' : verified.reason).toBe('malformed');
  });

  test('signing an empty content type mints a URL that carries none at all', async () => {
    const clock = frozenClock(START);
    const url = await buildSignedUrl({
      secret: SECRET,
      key: KEY,
      method: 'PUT',
      expiresInMs: 60_000,
      contentType: '',
      clock,
    });
    expect(url).not.toContain('x-ct=');
    const verified = await verifySignedUrl({ url, secret: SECRET, clock });
    expect(verified.ok).toBe(true);
    expect(verified.ok ? verified.constraints.contentType : 'set').toBeUndefined();
  });
});

/**
 * A URL is minted once and verified elsewhere, so a bad number at the mint is discovered by the
 * RECIPIENT: `expiresInMs: NaN` makes `expiresAt` `NaN`, which `String()` writes into the query as
 * the literal `NaN`, which `parseConstraints` then refuses as `malformed`. Every link the app
 * hands out is dead on arrival, the app's own code path succeeded, and the only report is a 400 at
 * a caller who cannot fix it. `verifySignedUrl` has screened its side with `Number.isSafeInteger`
 * from the start; this is the same screen on the side that writes the number.
 */
describe('buildSignedUrl refuses a constraint it could not verify back', () => {
  const mint = (extra: Record<string, unknown>): Promise<string> =>
    buildSignedUrl({ secret: SECRET, key: KEY, ...extra });

  for (const expiresInMs of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1, 1.5]) {
    test(`expiresInMs: ${String(expiresInMs)} is refused at the mint`, async () => {
      await expect(mint({ expiresInMs })).rejects.toThrow(/X_INVARIANT/);
    });
  }

  test('maxBytes is screened on the same terms as the verifier screens it', async () => {
    await expect(mint({ method: 'PUT', maxBytes: Number.NaN })).rejects.toThrow(/maxBytes/);
    await expect(mint({ method: 'PUT', maxBytes: -1 })).rejects.toThrow(/X_INVARIANT/);
    // Zero is a real constraint: a PUT of nothing. The verifier accepts it, so the mint must too.
    await expect(mint({ method: 'PUT', maxBytes: 0 })).resolves.toContain('x-max=0');
  });

  test('a URL minted with ordinary constraints still verifies', async () => {
    const clock = frozenClock(START);
    const url = await buildSignedUrl({
      secret: SECRET,
      key: KEY,
      expiresInMs: 60_000,
      clock,
    });
    expect((await verifySignedUrl({ url, secret: SECRET, clock })).ok).toBe(true);
  });
});

/**
 * `??` coalesces on `null` as well as `undefined`, so an explicit `null` — what a decoded JSON
 * config carries for a key someone blanked — took the default BEFORE the guard above could refuse
 * it. The mirror of the `NaN` half: one slips past the guard, the other past the default, and both
 * end in a bound nobody chose. `JSON.parse` rather than a literal, because `null` is not in the
 * option's type and this is the caller the bug is about.
 */
describe('an explicitly null bound is refused, never defaulted', () => {
  test('expiresInMs: null names itself instead of taking the 15-minute default', async () => {
    const fromJson: number = JSON.parse('null');
    await expect(
      buildSignedUrl({ secret: SECRET, key: KEY, expiresInMs: fromJson }),
    ).rejects.toThrow(/expiresInMs/);
  });
});
