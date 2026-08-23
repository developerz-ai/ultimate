// `UltimateRequest` is the only door a handler has to params, query and body, so whatever it
// mis-parses or lets past the size limit is beyond the reach of any later check. These tests
// pin the parse and the refusal together: every rejection has to arrive as an HttpError
// carrying a code and a cause, never as a raw throw from the runtime.
import { describe, expect, test } from 'bun:test';
import { localeConfig } from '@ultimat3/i18n';
import { t } from '@ultimat3/schema';
import { timeConfig } from '@ultimat3/time';
import { defineHttpConfig, type HttpConfigInput } from './config';
import { createRequestContext } from './context';
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
  const ctx = createRequestContext({
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

const captureSyncError = (run: () => unknown): HttpError | undefined => {
  try {
    run();
  } catch (error) {
    if (error instanceof HttpError) return error;
    throw error;
  }
  return undefined;
};

describe('getters', () => {
  test('delegate to ctx and raw for a plain GET', () => {
    const { req, ctx, raw, url } = build('https://example.com/posts/1?x=1');
    ctx.params = { id: '1' };

    expect(req.method).toBe('GET');
    expect(req.url).toBe(url);
    expect(req.pathname).toBe('/posts/1');
    expect(req.headers).toBe(raw.headers);
    expect(req.params).toEqual({ id: '1' });
    expect(req.actor).toEqual(ctx.actor);
    expect(req.locale).toBe(localeConfig().fallback);
    expect(req.tz).toBe(timeConfig().defaultZone);
    expect(req.requestId).toBe(ctx.requestId);
    expect(req.buildId).toBeNull();
  });

  test('method is uppercased, matching what createRequestContext already normalised', () => {
    const url = new URL('https://example.com/x');
    const config = defineHttpConfig({
      rateLimit: { scope: 'process' },
    });
    const ctx = createRequestContext({ url, method: 'get', role: 'web', config });
    const req = new UltimateRequest(new Request(url), ctx);
    expect(req.method).toBe('GET');
  });

  test('headers come from raw, not from ctx', () => {
    const { req, ctx, raw } = build('https://example.com/x', {
      headers: { 'x-test': 'yes' },
    });
    expect(req.headers.get('x-test')).toBe('yes');
    expect(req.headers).toBe(raw.headers);
    expect(req.headers).not.toBe(ctx.headers);
  });

  test('buildId reflects ctx.clientBuildId once the client sends one', () => {
    const { req, ctx } = build('https://example.com/x');
    ctx.clientBuildId = 'client-9';
    expect(req.buildId).toBe('client-9');
  });
});

describe('header()', () => {
  test('returns the raw header value, or null when absent', () => {
    const { req } = build('https://example.com/x', { headers: { 'x-foo': 'bar' } });
    expect(req.header('x-foo')).toBe('bar');
    expect(req.header('x-missing')).toBeNull();
  });
});

// `hooks.authenticate` is handed this object and nothing else, so this is the only seam a
// session lookup has. Without it every app rolls its own `Cookie` split — a second parser for
// a header whose escaping rules the framework already knows.
describe('cookie()', () => {
  const cookies = (header: string) =>
    build('https://example.com/x', { headers: { cookie: header } }).req;

  test('reads one cookie out of the header and url-decodes it', () => {
    const req = cookies('x-locale=de; session=a%20b; theme=dark');
    expect(req.cookie('session')).toBe('a b');
    expect(req.cookie('theme')).toBe('dark');
  });

  test('an absent cookie, and a request with no Cookie header at all, read null', () => {
    expect(cookies('theme=dark').cookie('session')).toBeNull();
    expect(build('https://example.com/x').req.cookie('session')).toBeNull();
  });

  test('a name that is only a prefix of another cookie does not match it', () => {
    expect(cookies('session_id=nope').cookie('session')).toBeNull();
  });
});

describe('param()', () => {
  test('returns the matched route param', () => {
    const { req, ctx } = build('https://example.com/posts/42');
    ctx.params = { id: '42' };
    expect(req.param('id')).toBe('42');
  });

  test('a missing param throws X_BODY_INVALID naming the :segment', () => {
    const { req, ctx } = build('https://example.com/posts/42');
    ctx.params = { id: '42' };
    expect(() => req.param('missing')).toThrow();

    const error = captureSyncError(() => req.param('missing'));
    expect(error?.code).toBe('X_BODY_INVALID');
    expect(error?.cause).toContain('missing');
    expect(error?.cause).toContain(':missing');
  });
});

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

describe('body()', () => {
  test('a valid body parses through a real schema', async () => {
    const { req } = build('https://example.com/x', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'ada' }),
    });
    const schema = t.object({ name: t.string });
    expect(await req.body(schema)).toEqual({ name: 'ada' });
  });

  test('an invalid body throws X_BODY_INVALID with the schema issues', async () => {
    const { req } = build('https://example.com/x', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 42 }),
    });
    const schema = t.object({ name: t.string });
    const error = await captureError(() => req.body(schema));
    expect(error?.code).toBe('X_BODY_INVALID');
    expect(error?.cause.length).toBeGreaterThan(0);
  });
});

describe('assertBuild()', () => {
  test('does nothing when the server has no buildId configured', () => {
    const { req, ctx } = build('https://example.com/x', {}, { buildId: null });
    ctx.clientBuildId = 'client-1';
    expect(() => req.assertBuild()).not.toThrow();
  });

  test('does nothing when the client sent no buildId', () => {
    const { req, ctx } = build('https://example.com/x', {}, { buildId: 'server-1' });
    expect(ctx.clientBuildId).toBeNull();
    expect(() => req.assertBuild()).not.toThrow();
  });

  test('does nothing when client and server build ids match', () => {
    const { req, ctx } = build('https://example.com/x', {}, { buildId: 'server-1' });
    ctx.clientBuildId = 'server-1';
    expect(() => req.assertBuild()).not.toThrow();
  });

  test('throws X_BUILD_SKEW naming both ids when they differ', () => {
    const { req, ctx } = build('https://example.com/x', {}, { buildId: 'server-1' });
    ctx.clientBuildId = 'client-2';
    const error = captureSyncError(() => req.assertBuild());
    expect(error?.code).toBe('X_BUILD_SKEW');
    expect(error?.cause).toContain('client-2');
    expect(error?.cause).toContain('server-1');
  });
});
