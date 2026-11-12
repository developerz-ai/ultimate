// The one answer for a stored object, without a disk or a pipeline behind it: every status it can
// give, what each one opens, and the two options a caller owns.

import { describe, expect, test } from 'bun:test';
import { compressResponse } from './compress';
import type { ObjectRequest, ObjectSource } from './object-response';
import { etagMatches, notModified, objectResponse } from './object-response';

const BYTES = new TextEncoder().encode('0123456789');

const requestWith = (headers: Readonly<Record<string, string>> = {}): ObjectRequest => ({
  header: (name) => headers[name] ?? null,
});

/** A source that records every range it was opened with. */
function sourceOf(
  object: Partial<ObjectSource['object']> = {},
): ObjectSource & { readonly opened: unknown[] } {
  const opened: unknown[] = [];
  return {
    opened,
    object: { contentType: 'image/png', size: BYTES.byteLength, etag: 'abc', ...object },
    open: (range) => {
      opened.push(range);
      return range === undefined ? BYTES.slice() : BYTES.slice(range.start, range.end + 1);
    },
  };
}

describe('objectResponse', () => {
  test('200: the whole object, its type, length, validator and date', async () => {
    const lastModified = new Date('2026-01-02T03:04:05.000Z');
    const source = sourceOf({ lastModified });
    const response = await objectResponse(requestWith(), source);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('0123456789');
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('content-length')).toBe('10');
    expect(response.headers.get('accept-ranges')).toBe('bytes');
    expect(response.headers.get('etag')).toBe('"abc"');
    expect(response.headers.get('last-modified')).toBe('Fri, 02 Jan 2026 03:04:05 GMT');
    expect(source.opened).toEqual([undefined]);
  });

  test('206: open receives the parsed range and answers exactly that window', async () => {
    const source = sourceOf();
    const response = await objectResponse(requestWith({ range: 'bytes=2-5' }), source);
    expect(response.status).toBe(206);
    expect(await response.text()).toBe('2345');
    expect(response.headers.get('content-range')).toBe('bytes 2-5/10');
    expect(response.headers.get('content-length')).toBe('4');
    expect(source.opened).toEqual([{ start: 2, end: 5 }]);
  });

  test('304: a matching validator opens nothing', async () => {
    const source = sourceOf();
    const response = await objectResponse(requestWith({ 'if-none-match': 'W/"abc"' }), source);
    expect(response.status).toBe(304);
    expect(response.headers.get('etag')).toBe('"abc"');
    expect(source.opened).toEqual([]);
  });

  test('416: a window past the end opens nothing and names the size', async () => {
    const source = sourceOf();
    const response = await objectResponse(requestWith({ range: 'bytes=10-' }), source);
    expect(response.status).toBe(416);
    expect(response.headers.get('content-range')).toBe('bytes */10');
    expect(source.opened).toEqual([]);
  });

  test('if-range: a validator that is not this revision ignores the range, and opens it whole', async () => {
    const stale = sourceOf();
    const response = await objectResponse(
      requestWith({ range: 'bytes=5-', 'if-range': '"old"' }),
      stale,
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('0123456789');
    expect(response.headers.get('content-range')).toBeNull();
    expect(stale.opened).toEqual([undefined]);
  });

  test('if-range: this revision keeps the window, by etag or by exact date', async () => {
    const lastModified = new Date('2026-01-02T03:04:05.000Z');
    for (const validator of ['"abc"', 'Fri, 02 Jan 2026 03:04:05 GMT']) {
      const response = await objectResponse(
        requestWith({ range: 'bytes=5-', 'if-range': validator }),
        sourceOf({ lastModified }),
      );
      expect(response.status).toBe(206);
    }
  });

  test('if-range: a weak or unknowable validator never keeps a window', async () => {
    const lastModified = new Date('2026-01-02T03:04:05.000Z');
    const cases = [
      { etag: 'abc', validator: 'W/"abc"' },
      { etag: 'W/"abc"', validator: 'W/"abc"' },
      { etag: undefined, validator: '"abc"' },
      { etag: 'abc', validator: 'Sat, 03 Jan 2026 03:04:05 GMT' },
    ];
    for (const { etag, validator } of cases) {
      const response = await objectResponse(
        requestWith({ range: 'bytes=5-', 'if-range': validator }),
        sourceOf({ etag, lastModified }),
      );
      expect(response.status).toBe(200);
    }
  });

  test('if-range that fails turns an unsatisfiable window into the whole object, not a 416', async () => {
    const response = await objectResponse(
      requestWith({ range: 'bytes=99-', 'if-range': '"old"' }),
      sourceOf(),
    );
    expect(response.status).toBe(200);
  });

  test('no etag, or an unknowable one: no header, and if-none-match cannot match', async () => {
    for (const etag of [undefined, '']) {
      const source = sourceOf({ etag });
      const response = await objectResponse(requestWith({ 'if-none-match': '*' }), source);
      expect(response.status).toBe(200);
      expect(response.headers.get('etag')).toBeNull();
    }
  });

  test('a provider etag that arrives quoted is not quoted twice', async () => {
    const source = sourceOf({ etag: '"abc-2"' });
    const response = await objectResponse(requestWith(), source);
    expect(response.headers.get('etag')).toBe('"abc-2"');
    const again = await objectResponse(requestWith({ 'if-none-match': '"abc-2"' }), source);
    expect(again.status).toBe(304);
  });

  test('a type a browser would run is a sandboxed download; an image is shown', async () => {
    const html = await objectResponse(requestWith(), sourceOf({ contentType: 'text/html' }));
    expect(html.headers.get('content-disposition')).toBe('attachment');
    expect(html.headers.get('content-security-policy')).toBe('sandbox');
    const png = await objectResponse(requestWith(), sourceOf());
    expect(png.headers.get('content-disposition')).toBeNull();
    expect(png.headers.get('content-security-policy')).toBeNull();
  });

  test('`headers` replaces the sandbox rule rather than adding beside it', async () => {
    const response = await objectResponse(requestWith(), sourceOf({ contentType: 'text/html' }), {
      headers: { 'content-disposition': 'inline', 'x-own': '1' },
    });
    expect(response.headers.get('content-disposition')).toBe('inline');
    expect(response.headers.get('x-own')).toBe('1');
    expect(response.headers.get('content-security-policy')).toBeNull();
  });

  test('the cache hint reaches every status; omitted, the handler sets none', async () => {
    const cache = { mode: 'private', maxAgeSeconds: 0, vary: ['cookie'] } as const;
    for (const headers of [{}, { 'if-none-match': '"abc"' }, { range: 'bytes=2-3' }]) {
      const response = await objectResponse(requestWith(headers), sourceOf(), { cache });
      expect(response.headers.get('cache-control')).toContain('private');
      expect(response.headers.get('vary')).toContain('cookie');
    }
    const declared = await objectResponse(requestWith(), sourceOf());
    expect(declared.headers.get('cache-control')).toBeNull();
  });

  test('open may answer asynchronously, with a stream', async () => {
    const response = await objectResponse(requestWith(), {
      object: { contentType: 'video/mp4', size: 3 },
      open: async () => new Blob(['abc']).stream(),
    });
    expect(await response.text()).toBe('abc');
  });
});

describe('notModified', () => {
  test('a matching validator is a bodiless 304 carrying the etag and the given headers', async () => {
    const response = notModified(requestWith({ 'if-none-match': 'W/"abc"' }), '"abc"', {
      'cache-control': 'no-cache',
    });
    expect(response?.status).toBe(304);
    expect(response?.headers.get('etag')).toBe('"abc"');
    expect(response?.headers.get('cache-control')).toBe('no-cache');
    expect(await response?.text()).toBe('');
  });

  test('anything else is no answer at all, so the caller goes on to send the body', () => {
    expect(notModified(requestWith(), '"abc"')).toBeUndefined();
    expect(notModified(requestWith({ 'if-none-match': '"old"' }), '"abc"')).toBeUndefined();
  });

  test('a weak etag of its own still matches', () => {
    expect(notModified(requestWith({ 'if-none-match': '"abc"' }), 'W/"abc"')?.status).toBe(304);
  });
});

describe('etagMatches', () => {
  test('*, a weak validator and a comma list count; anything else does not', () => {
    expect(etagMatches('"abc"', '"abc"')).toBe(true);
    expect(etagMatches('W/"abc"', '"abc"')).toBe(true);
    expect(etagMatches('"other", "abc"', '"abc"')).toBe(true);
    expect(etagMatches('*', '"abc"')).toBe(true);
    expect(etagMatches('"other"', '"abc"')).toBe(false);
    expect(etagMatches(null, '"abc"')).toBe(false);
  });
});

describe('through the compress stage', () => {
  const CSS = new TextEncoder().encode('a { color: var(--text); }\n'.repeat(200));
  const css: ObjectSource = {
    object: { contentType: 'text/css', size: CSS.byteLength, etag: 'css-1' },
    open: () => CSS.slice(),
  };
  const through = async (headers: Readonly<Record<string, string>>) => {
    const request = new Request('http://app.test/a.css', { headers });
    const response = await objectResponse(requestWith(headers), css, {
      cache: { mode: 'public', maxAgeSeconds: 60 },
    });
    return compressResponse(request, response, { anonymous: true });
  };

  // RFC 9110 §15.4.5: a cache that updates its stored headers from the 304 must not come away
  // holding a strong validator for gzip bytes.
  test("the 304's validator equals the 200's, byte for byte", async () => {
    const full = await through({ 'accept-encoding': 'gzip' });
    expect(full.headers.get('content-encoding')).toBe('gzip');
    const tag = full.headers.get('etag') as string;
    const revalidated = await through({ 'accept-encoding': 'gzip', 'if-none-match': tag });
    expect(revalidated.status).toBe(304);
    expect(revalidated.headers.get('etag')).toBe(tag);
  });
});
