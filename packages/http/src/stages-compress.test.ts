// The `compress` stage inside the real lifecycle: what the stages before it decided has to reach
// the client through the rebuild, and what the actor changed about the cache answer decides the
// coding. `compress.test.ts` holds the rule; this holds its place in the order.
import { describe, expect, test } from 'bun:test';
import { type Actor, anonymousActor } from '@ultimat3/core';
import { defineHttpConfig } from './config';
import { notModified } from './object-response';
import { httpPipeline } from './pipeline';
import { html, jsonResponse, stream, textResponse } from './response';
import { httpRouter, type Route } from './router';
import { setCookie } from './set-cookie';

const MARKUP = `<!doctype html><title>x</title>${'<p>hello</p>'.repeat(400)}`;
const ETAG = '"doc-1"';

const routes: readonly Route[] = [
  {
    method: 'GET',
    path: '/doc',
    meta: { name: 'doc', auth: 'public' },
    handler: () => html(MARKUP),
  },
  {
    method: 'GET',
    path: '/cookied',
    meta: { name: 'cookied', auth: 'public' },
    handler: () => {
      setCookie('a', '1');
      setCookie('b', '2');
      return html(MARKUP);
    },
  },
  {
    method: 'GET',
    path: '/validated',
    meta: { name: 'validated', auth: 'public' },
    handler: (request) => {
      const headers = { 'content-type': 'text/html; charset=utf-8', etag: ETAG };
      return notModified(request, ETAG, headers) ?? html(MARKUP, { headers });
    },
  },
  {
    method: 'GET',
    path: '/stream',
    meta: { name: 'stream', auth: 'public' },
    handler: () => stream(new Blob([MARKUP]).stream()),
  },
  {
    method: 'GET',
    path: '/admin',
    meta: { name: 'admin', auth: 'required' },
    handler: () => jsonResponse({ page: MARKUP }),
  },
  {
    method: 'GET',
    path: '/plain',
    meta: { name: 'plain', auth: 'public' },
    handler: () => textResponse(MARKUP),
  },
];

const member: Actor = { ...anonymousActor(), id: 'member-1', kind: 'user' };

const pipelineFor = (actor: Actor | null) =>
  httpPipeline({
    table: httpRouter(routes),
    config: defineHttpConfig({ rateLimit: { scope: 'process' }, dev: false, buildId: null }),
    hooks: { authenticate: () => actor },
  });

const get = (
  pipeline: ReturnType<typeof pipelineFor>,
  path: string,
  headers: Record<string, string> = { 'accept-encoding': 'gzip' },
) => pipeline.handle(new Request(`http://localhost${path}`, { headers }), { role: 'web' });

describe('the compress stage, in the lifecycle', () => {
  test('sits last, so it sees the final cache answer', () => {
    expect(pipelineFor(null).stages.at(-1)?.name).toBe('compress');
  });

  test('every header the response stage set survives the rebuild', async () => {
    const pipeline = pipelineFor(null);
    const identity = await get(pipeline, '/doc', {});
    const coded = await get(pipeline, '/doc');
    expect(coded.headers.get('content-encoding')).toBe('gzip');
    expect(identity.headers.get('content-encoding')).toBeNull();
    for (const name of [
      'content-security-policy',
      'x-content-type-options',
      'x-frame-options',
      'referrer-policy',
      'cache-control',
    ]) {
      expect(coded.headers.get(name), name).toBe(identity.headers.get(name));
    }
    expect(coded.headers.has('x-request-id')).toBe(true);
    expect(coded.headers.has('server-timing')).toBe(true);
    expect(identity.headers.get('x-content-type-options')).toBe('nosniff');
    expect(new TextDecoder().decode(Bun.gunzipSync(await coded.bytes()))).toBe(MARKUP);
  });

  test('two cookies are still two lines', async () => {
    const coded = await get(pipelineFor(null), '/cookied');
    expect(coded.headers.get('content-encoding')).toBe('gzip');
    expect(coded.headers.getSetCookie().length).toBe(2);
  });

  test('a signed-in document is identity, the anonymous one beside it is not', async () => {
    const signedIn = await get(pipelineFor(member), '/doc');
    expect(signedIn.headers.get('cache-control')).toContain('private');
    expect(signedIn.headers.get('content-encoding')).toBeNull();
    expect(await signedIn.text()).toBe(MARKUP);
    const anonymous = await get(pipelineFor(null), '/doc');
    expect(anonymous.headers.get('content-encoding')).toBe('gzip');
  });

  test('a required route is no-store, so its answer is identity', async () => {
    const answer = await get(pipelineFor(member), '/admin');
    expect(answer.headers.get('cache-control')).toBe('no-store');
    expect(answer.headers.get('content-encoding')).toBeNull();
  });

  // v31: coded as a stream rather than left identity — no length is claimed, every byte arrives.
  test('a shared stream with no declared length is gzip, whole, with no length', async () => {
    const answer = await get(pipelineFor(null), '/stream');
    expect(answer.headers.get('content-encoding')).toBe('gzip');
    expect(answer.headers.has('content-length')).toBe(false);
    const bytes = new Uint8Array(await answer.arrayBuffer());
    expect(new TextDecoder().decode(Bun.gunzipSync(bytes))).toBe(MARKUP);
  });

  test('a type off the list is identity, whatever its size', async () => {
    const answer = await get(pipelineFor(null), '/plain');
    expect(answer.headers.get('content-encoding')).toBeNull();
  });

  test('a body that stalls is held only until the request deadline', async () => {
    const stalling: Route = {
      method: 'GET',
      path: '/stalls',
      meta: { name: 'stalls', auth: 'public' },
      handler: () =>
        new Response(new ReadableStream<Uint8Array>({ pull: () => new Promise(() => {}) }), {
          headers: { 'content-type': 'text/css', 'content-length': '2000' },
        }),
    };
    const pipeline = httpPipeline({
      table: httpRouter([stalling]),
      config: defineHttpConfig({
        rateLimit: { scope: 'process' },
        dev: false,
        buildId: null,
        requestTimeoutMs: 20,
      }),
    });
    const answer = await pipeline.handle(
      new Request('http://localhost/stalls', { headers: { 'accept-encoding': 'gzip' } }),
      { role: 'web' },
    );
    expect(answer.status).toBe(200);
    expect(answer.headers.get('content-encoding')).toBeNull();
  });

  test('the weakened tag comes back and answers 304', async () => {
    const pipeline = pipelineFor(null);
    const coded = await get(pipeline, '/validated');
    const tag = coded.headers.get('etag') as string;
    expect(tag).toBe(`W/${ETAG}`);
    const again = await get(pipeline, '/validated', {
      'accept-encoding': 'gzip',
      'if-none-match': tag,
    });
    expect(again.status).toBe(304);
    expect(again.headers.get('content-encoding')).toBeNull();
  });
});
