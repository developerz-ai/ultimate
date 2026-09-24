// The one same-origin rule an ambient credential is admitted on — `@ultimat3/http`'s CSRF check
// and `@ultimat3/realtime`'s websocket upgrade both ask it, so a sibling origin cannot be let in
// by one surface and refused by the other.
import { describe, expect, test } from 'bun:test';
import { proveSameOrigin } from './same-origin';

const base = {
  selfOrigins: ['https://app.example.com'],
  origin: null,
  secFetchSite: null,
  listed: () => false,
  listName: 'http.cors.origins',
} as const;

describe('proveSameOrigin', () => {
  test("the browser's own sec-fetch-site: same-origin and none are proof", () => {
    expect(proveSameOrigin({ ...base, secFetchSite: 'same-origin' })).toEqual({ ok: true });
    expect(proveSameOrigin({ ...base, secFetchSite: 'none' })).toEqual({ ok: true });
  });

  // A sibling subdomain is SAME-SITE, and SameSite=Lax cookies ride its requests: same-site is
  // not same-origin and is refused unless its origin is listed.
  test('same-site is not same-origin', () => {
    const verdict = proveSameOrigin({
      ...base,
      secFetchSite: 'same-site',
      origin: 'https://evil.example.com',
    });
    expect(verdict).toEqual({
      ok: false,
      reason: 'the request reported sec-fetch-site: same-site',
    });
  });

  test('an Origin equal to one of the self origins is proof', () => {
    expect(proveSameOrigin({ ...base, origin: 'https://app.example.com' })).toEqual({ ok: true });
  });

  test('a listed origin is admitted, exactly', () => {
    const listed = (origin: string): boolean => origin === 'https://admin.example.com';
    expect(proveSameOrigin({ ...base, listed, origin: 'https://admin.example.com' })).toEqual({
      ok: true,
    });
    expect(proveSameOrigin({ ...base, listed, origin: 'https://admin.example.com.evil' }).ok).toBe(
      false,
    );
  });

  test('the refusal names the list an operator would add to, and never echoes a header', () => {
    const verdict = proveSameOrigin({
      ...base,
      origin: 'https://x.test',
      listName: 'SYNC_ORIGINS',
    });
    expect(verdict).toEqual({
      ok: false,
      reason: 'the origin it declares is not this app and is not listed in SYNC_ORIGINS',
    });
    const odd = proveSameOrigin({ ...base, secFetchSite: 'hunter2' });
    expect(JSON.stringify(odd)).not.toContain('hunter2');
  });

  test('neither header is not proof', () => {
    expect(proveSameOrigin(base)).toEqual({
      ok: false,
      reason:
        'the request carried neither sec-fetch-site nor origin, so it cannot be shown to be same-origin',
    });
  });
});
