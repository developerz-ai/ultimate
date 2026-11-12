// A part URL binds its exact length, inside the signature: the local disks then refuse a short
// part as s3 does. A part URL minted before the length was signed is refused, never honoured.

import { describe, expect, test } from 'bun:test';
import { frozenClock } from '@ultimat3/core';
import { buildSignedUrl, SIGNED_URL_PARAMS, verifySignedUrl } from './signed-url';

const SECRET = 'test-signing-secret';
const KEY = 'org/org-1/film.mp4';
const clock = frozenClock('2026-07-26T12:00:00.000Z');
const part = { uploadId: 'upload-1', partNumber: 2, length: 4 };

const partUrl = (): Promise<string> =>
  buildSignedUrl({ secret: SECRET, key: KEY, method: 'PUT', maxBytes: 4, part, clock });

const hmac = async (canonical: string): Promise<string> => {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(canonical));
  return [...new Uint8Array(mac)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};

describe('a part URL signs its exact length', () => {
  test('the length round-trips through the signature', async () => {
    const verified = await verifySignedUrl({ url: await partUrl(), secret: SECRET, clock });
    expect(verified.ok ? verified.constraints.part : undefined).toEqual(part);
  });

  test('an edited or dropped length does not verify', async () => {
    for (const edit of [
      (url: URL) => url.searchParams.set(SIGNED_URL_PARAMS.partLength, '3'),
      (url: URL) => url.searchParams.delete(SIGNED_URL_PARAMS.partLength),
    ]) {
      const url = new URL(await partUrl(), 'http://app.test');
      edit(url);
      const verified = await verifySignedUrl({ url: url.toString(), secret: SECRET, clock });
      expect(verified.ok).toBe(false);
    }
  });

  test('a part URL in the form minted before the length was signed is malformed', async () => {
    const expires = clock.now().getTime() + 60_000;
    const old = ['v2-part', '/_storage', 'PUT', KEY, String(expires), '4', '', 'upload-1', '2'];
    const params = new URLSearchParams({
      [SIGNED_URL_PARAMS.method]: 'PUT',
      [SIGNED_URL_PARAMS.expires]: String(expires),
      [SIGNED_URL_PARAMS.maxBytes]: '4',
      [SIGNED_URL_PARAMS.uploadId]: 'upload-1',
      [SIGNED_URL_PARAMS.partNumber]: '2',
      [SIGNED_URL_PARAMS.signature]: await hmac(old.join('\n')),
    });
    const url = `/_storage/${KEY}?${params.toString()}`;
    const verified = await verifySignedUrl({ url, secret: SECRET, clock });
    expect(verified.ok ? 'verified' : verified.reason).toBe('malformed');
  });

  test('a part with no length, or a length that is not a byte count, is refused at the mint', async () => {
    for (const length of [undefined, -1, 1.5, Number.NaN]) {
      const minted = buildSignedUrl({
        secret: SECRET,
        key: KEY,
        method: 'PUT',
        part: { uploadId: 'upload-1', partNumber: 2, length },
        clock,
      });
      await expect(minted).rejects.toMatchObject({ code: 'X_INVARIANT' });
    }
  });
});
