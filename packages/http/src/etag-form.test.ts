// The coding an exchange is offered, and the validator that offer implies: one decision read by
// the coded 200 and by the 304 that revalidates it, so the two can never name different forms.
import { describe, expect, test } from 'bun:test';
import { answer, asking, compressAnonymous } from './compress-fixture';
import { CONTENT_CODINGS, etagForm, negotiateCoding } from './etag-form';

describe('negotiateCoding', () => {
  test.each([
    ['gzip', 'gzip'],
    ['GZIP', 'gzip'],
    ['zstd', 'zstd'],
    ['gzip, deflate, br, zstd', 'zstd'],
    ['zstd, gzip', 'zstd'],
    ['br, gzip', 'gzip'],
    ['gzip;q=1, zstd;q=0.5', 'gzip'],
    ['zstd;q=0.5, gzip;q=0.5', 'zstd'],
    ['zstd;q=0, gzip', 'gzip'],
    ['gzip;q=0.5', 'gzip'],
    ['gzip ; q=1.0', 'gzip'],
    ['gzip;q=0', undefined],
    ['gzip; q=0.000', undefined],
    ['gzip;q=nonsense', undefined],
    ['br, deflate', undefined],
    ['br', undefined],
    ['gzipped', undefined],
    ['*', undefined],
    [null, undefined],
  ] as const)('%s → %p', (accept, coding) => {
    expect(negotiateCoding(accept)).toBe(coding);
  });

  // The probe (Bun 1.4.4): `br` exists only as `CompressionStream('brotli')` at quality 11, about
  // 850 ms per 256 KiB, or through `node:zlib`. Offering it would mean one of the two.
  test('offers only what the runtime codes natively and cheaply, in preference order', () => {
    expect(CONTENT_CODINGS).toEqual(['zstd', 'gzip']);
  });
});

describe('etagForm', () => {
  test('an offered coding weakens a strong validator, once', () => {
    expect(etagForm('"abc"', 'gzip')).toBe('W/"abc"');
    expect(etagForm('W/"abc"', 'zstd')).toBe('W/"abc"');
  });

  test('no coding offered keeps it strong', () => {
    expect(etagForm('"abc"', undefined)).toBe('"abc"');
  });
});

describe('the 304 names the validator the 200 named', () => {
  const ETAG = '"doc-1"';
  const notModifiedAnswer = (headers: Record<string, string> = {}) =>
    new Response(null, {
      status: 304,
      headers: {
        etag: ETAG,
        'content-type': 'text/css; charset=utf-8',
        'cache-control': 'public, max-age=0, must-revalidate',
        ...headers,
      },
    });

  test.each(['gzip', 'zstd'])('under %s, byte for byte', async (accept) => {
    const full = await compressAnonymous(asking(accept), answer(undefined, { etag: ETAG }));
    const revalidated = await compressAnonymous(asking(accept), notModifiedAnswer());
    expect(revalidated.status).toBe(304);
    expect(revalidated.headers.get('etag')).toBe(full.headers.get('etag'));
    expect(revalidated.headers.get('etag')).toBe(`W/${ETAG}`);
  });

  test('a body under the floor is identity, and its validator follows the offer all the same', async () => {
    const small = answer('a{}', { etag: ETAG, 'content-length': '3' });
    const full = await compressAnonymous(asking(), small);
    expect(full.headers.has('content-encoding')).toBe(false);
    const revalidated = await compressAnonymous(asking(), notModifiedAnswer());
    expect(revalidated.headers.get('etag')).toBe(full.headers.get('etag'));
  });

  test('with no coding offered both stay strong', async () => {
    const full = await compressAnonymous(asking(null), answer(undefined, { etag: ETAG }));
    const revalidated = await compressAnonymous(asking(null), notModifiedAnswer());
    expect(full.headers.get('etag')).toBe(ETAG);
    expect(revalidated.headers.get('etag')).toBe(ETAG);
  });

  test('a type never coded keeps both strong', async () => {
    const png = { 'content-type': 'image/png' };
    const full = await compressAnonymous(asking(), answer(undefined, { etag: ETAG, ...png }));
    const revalidated = await compressAnonymous(asking(), notModifiedAnswer(png));
    expect(full.headers.get('etag')).toBe(ETAG);
    expect(revalidated.headers.get('etag')).toBe(ETAG);
  });

  test('a private answer keeps both strong', async () => {
    const shut = { 'cache-control': 'private, max-age=0' };
    const full = await compressAnonymous(asking(), answer(undefined, { etag: ETAG, ...shut }));
    const revalidated = await compressAnonymous(asking(), notModifiedAnswer(shut));
    expect(full.headers.get('etag')).toBe(ETAG);
    expect(revalidated.headers.get('etag')).toBe(ETAG);
  });
});
