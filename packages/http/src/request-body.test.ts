// bodyRaw(), the one reader of a request body: GET and HEAD never read one, the size limit, no body
// to parse, the content-type dispatch and its cache. Split from request.test.ts.

import { describe, expect, test } from 'bun:test';
import { defineHttpConfig, type HttpConfigInput } from './config';
import { requestContext } from './context';
import { HttpError } from './errors';
import { UltimateRequest } from './request';

/** One request/context/config triple per test, built consistently. */
const build = (
  urlString: string,
  requestInit: RequestInit = {},
  configInput: HttpConfigInput = {},
) => {
  const url = new URL(urlString);
  const config = defineHttpConfig({ rateLimit: { scope: 'process' }, ...configInput });
  const ctx = requestContext({
    url,
    method: (requestInit.method ?? 'GET').toString(),
    role: 'web',
    config,
  });
  const raw = new Request(url, requestInit);
  return { req: new UltimateRequest(raw, ctx), ctx, config, raw, url };
};

/**
 * Captures the HttpError a call is expected to throw. A call that does not throw leaves the
 * capture `undefined`, which fails the caller's `?.code` assertion — an unexpected success is
 * a bug, not a pass. Anything that is not an HttpError is rethrown rather than reported as a
 * missing code, so the real failure reaches the runner intact.
 */
const captureError = async (run: () => Promise<unknown>): Promise<HttpError | undefined> => {
  try {
    await run();
  } catch (error) {
    if (error instanceof HttpError) return error;
    throw error;
  }
  return undefined;
};

describe('bodyRaw() — GET/HEAD never read a body', () => {
  test('GET resolves to undefined, even with a content-length header set', async () => {
    const { req } = build('https://example.com/x', { headers: { 'content-length': '999' } });
    expect(await req.bodyRaw()).toBeUndefined();
  });

  test('HEAD resolves to undefined', async () => {
    const { req } = build('https://example.com/x', { method: 'HEAD' });
    expect(await req.bodyRaw()).toBeUndefined();
  });
});

describe('bodyRaw() — size limit', () => {
  test('a content-length over the limit throws X_BODY_INVALID before reading the body', async () => {
    const { req } = build(
      'https://example.com/x',
      { method: 'POST', headers: { 'content-length': '999999' }, body: 'irrelevant' },
      { bodyLimitBytes: 10 },
    );
    const error = await captureError(() => req.bodyRaw());
    expect(error?.code).toBe('X_BODY_INVALID');
    expect(error?.cause).toContain('999999');
    expect(error?.cause).toContain('10');
  });

  test('an actual body over the limit throws even when content-length was absent', async () => {
    const big = 'x'.repeat(50);
    const { req } = build(
      'https://example.com/x',
      { method: 'POST', headers: { 'content-type': 'text/plain' }, body: big },
      { bodyLimitBytes: 10 },
    );
    const error = await captureError(() => req.bodyRaw());
    expect(error?.code).toBe('X_BODY_INVALID');
    expect(error?.cause).toContain('50');
    expect(error?.cause).toContain('10');
  });

  // The shape a `content-length` pre-check can never see: `transfer-encoding: chunked`, no
  // declared length, a body far larger than the process should ever hold. Reading it whole and
  // measuring afterwards is an OOM where a 413 was owed.
  test('a chunked body over the limit is abandoned mid-stream, not materialised first', async () => {
    const chunk = new TextEncoder().encode('x'.repeat(64));
    let pulled = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });
    const { req } = build(
      'https://example.com/x',
      // No content-length: `duplex: 'half'` is what a streamed request body requires.
      {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body,
        duplex: 'half',
      } as RequestInit,
      { bodyLimitBytes: 128 },
    );

    const error = await captureError(() => req.bodyRaw());
    expect(error?.code).toBe('X_BODY_INVALID');
    expect(error?.cause).toContain('128');
    // The stream never ends, so finishing the read at all is the failure: without the cap this
    // test hangs or dies of memory rather than reporting.
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThan(10);
  });

  test('an undeclared multipart body is capped too, not handed to the runtime unbounded', async () => {
    const formData = new FormData();
    formData.set('note', 'y'.repeat(500));
    // Serialised through a throwaway Request so this one can carry the multipart content-type
    // with NO content-length — the case where the declared length was multipart's only guard.
    const source = new Request('https://example.com/x', { method: 'POST', body: formData });
    const { req } = build(
      'https://example.com/x',
      {
        method: 'POST',
        headers: { 'content-type': source.headers.get('content-type') ?? '' },
        body: new ReadableStream<Uint8Array>({
          async start(controller) {
            controller.enqueue(new Uint8Array(await source.arrayBuffer()));
            controller.close();
          },
        }),
        duplex: 'half',
      } as RequestInit,
      { bodyLimitBytes: 64 },
    );

    const error = await captureError(() => req.bodyRaw());
    expect(error?.code).toBe('X_BODY_INVALID');
    expect(error?.cause).toContain('64');
  });
});

describe('bodyRaw() — no body to parse', () => {
  test('a missing content-type returns undefined without attempting to parse', async () => {
    const { req } = build('https://example.com/x', { method: 'POST' });
    expect(await req.bodyRaw()).toBeUndefined();
  });

  test('content-length: 0 returns undefined even when content-type is set', async () => {
    const { req } = build('https://example.com/x', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': '0' },
    });
    expect(await req.bodyRaw()).toBeUndefined();
  });

  // A button-only `<form>` posts no fields at all. That is an empty form — `{}` — and a schema
  // with no required field accepts it; `undefined` was a 400 on every such button.
  test.each([
    [
      'urlencoded, content-length 0',
      'application/x-www-form-urlencoded',
      { 'content-length': '0' },
      '',
    ],
    ['urlencoded, no length and no bytes', 'application/x-www-form-urlencoded', {}, ''],
    [
      'multipart, content-length 0',
      'multipart/form-data; boundary=x',
      { 'content-length': '0' },
      '',
    ],
    // Chunked: no declared length, and the stream turns out to carry nothing.
    ['multipart, no length and no bytes', 'multipart/form-data; boundary=x', {}, ''],
  ] as const)('an empty form body is an empty form: %s', async (_label, type, extra, body) => {
    const { req } = build('https://example.com/x', {
      method: 'POST',
      headers: { 'content-type': type, ...extra },
      body,
    });
    expect(await req.bodyRaw()).toEqual({});
  });

  // The empty-form shortcut must not launder a malformed header: with a body, a multipart with no
  // boundary is refused by the parser, so without one it is refused the same way.
  test.each([
    ['content-length 0', { 'content-length': '0' }],
    ['no length and no bytes', {}],
  ] as const)(
    'an empty multipart body with no boundary is X_BODY_INVALID: %s',
    async (_label, extra) => {
      const { req } = build('https://example.com/x', {
        method: 'POST',
        headers: { 'content-type': 'multipart/form-data', ...extra },
        body: '',
      });
      const error = await captureError(() => req.bodyRaw());
      expect(error?.code).toBe('X_BODY_INVALID');
    },
  );
});

describe('bodyRaw() — content-type dispatch', () => {
  test('application/json round-trips valid JSON', async () => {
    const { req } = build('https://example.com/x', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ a: 1, b: 'two' }),
    });
    expect(await req.bodyRaw()).toEqual({ a: 1, b: 'two' });
  });

  test('malformed JSON throws X_BODY_INVALID naming the parse, never the payload', async () => {
    const { req } = build('https://example.com/x', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    const error = await captureError(() => req.bodyRaw());
    expect(error?.code).toBe('X_BODY_INVALID');
    expect(error?.cause).toContain('could not parse');
  });

  // The runtime's own `SyntaxError` quotes the token it choked on, so `String(error)` in the
  // catch put a FRAGMENT OF THE REQUEST BODY into `cause` — which `stages.ts` writes to the log
  // store as a field redaction-by-key cannot see, and `toProblem` sends back to the caller.
  test('a malformed body never echoes a fragment of itself into the cause', async () => {
    const { req } = build('https://example.com/x', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"password": hunter2SuperSecret}',
    });
    const error = await captureError(() => req.bodyRaw());
    expect(error?.code).toBe('X_BODY_INVALID');
    expect(error?.cause).not.toContain('hunter2SuperSecret');
    expect(error?.cause).not.toContain('password');
    // The diagnostic is kept where an operator can have it and a caller cannot: `meta` is never
    // rendered into the problem document, and it is rendered by core, not by `String(error)`.
    expect(String(error?.meta?.['parseError'])).toContain('hunter2SuperSecret');
  });

  test('a rejected content-type is described, never echoed', async () => {
    const { req } = build('https://example.com/x', {
      method: 'POST',
      headers: { 'content-type': 'application/x-marker-9f3c' },
      body: 'x',
    });
    const error = await captureError(() => req.bodyRaw());
    expect(error?.code).toBe('X_BODY_INVALID');
    expect(error?.cause).not.toContain('x-marker-9f3c');
    expect(error?.cause).toContain('application/json');
    expect(error?.meta?.['contentType']).toBe('application/x-marker-9f3c');
  });

  test('application/x-www-form-urlencoded parses into a plain object', async () => {
    const { req } = build('https://example.com/x', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'a=1&b=2',
    });
    expect(await req.bodyRaw()).toEqual({ a: '1', b: '2' });
  });

  // A checkbox group posts its name once per checked box. `Object.fromEntries` kept the LAST one,
  // so `tags` × 3 reached the body schema as one string — the query parser three files up has
  // built a list for the same shape since it shipped, and the two disagreed about one request.
  test('a repeated urlencoded field is a list, exactly as the query parser builds one', async () => {
    const { req } = build('https://example.com/x?tags=a&tags=b', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'tags=a&tags=b&tags=c&single=1',
    });
    expect(await req.bodyRaw()).toEqual({ tags: ['a', 'b', 'c'], single: '1' });
    expect(req.queryRaw()['tags']).toEqual(['a', 'b']);
  });

  test('a repeated multipart field is a list too — one collector, three sources', async () => {
    const form = new FormData();
    form.append('tags', 'a');
    form.append('tags', 'b');
    form.append('single', '1');
    const { req } = build('https://example.com/x', { method: 'POST', body: form });
    expect(await req.bodyRaw()).toEqual({ tags: ['a', 'b'], single: '1' });
  });

  test('text/plain returns the raw decoded string', async () => {
    const { req } = build('https://example.com/x', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'hello world',
    });
    expect(await req.bodyRaw()).toBe('hello world');
  });

  test('multipart/form-data returns a plain object built from the form entries', async () => {
    const formData = new FormData();
    formData.set('name', 'ada');
    formData.set('role', 'engineer');
    // Let Request compute the multipart boundary content-type itself.
    const { req } = build('https://example.com/x', { method: 'POST', body: formData });
    expect(await req.bodyRaw()).toEqual({ name: 'ada', role: 'engineer' });
  });

  test('an unsupported content-type throws X_BODY_INVALID', async () => {
    const { req } = build('https://example.com/x', {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: new Uint8Array([1, 2, 3]),
    });
    const error = await captureError(() => req.bodyRaw());
    expect(error?.code).toBe('X_BODY_INVALID');
    expect(error?.cause).toContain('content-type is not one of');
    expect(error?.meta?.['contentType']).toBe('application/octet-stream');
  });
});

describe('bodyRaw() — caching', () => {
  test('the second call returns the identical parsed value without re-reading the stream', async () => {
    const { req } = build('https://example.com/x', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ a: 1 }),
    });
    const first = await req.bodyRaw();
    const second = await req.bodyRaw();
    expect(first).toEqual({ a: 1 });
    expect(second).toBe(first);
  });
});
