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

  test('an absolute URL from a browser verifies identically', async () => {
    const clock = frozenClock(START);
    const url = await putUrl(clock);
    const absolute = `https://app.example.com${url}`;
    expect((await verifySignedUrl({ url: absolute, secret: SECRET, clock })).ok).toBe(true);
  });
});
