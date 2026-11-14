// A real socket and a raw `fetch`: only the wire can say what actually left the container. With
// `decompress: false` the bytes counted are the bytes sent, which is the figure a visitor pays.
//
//   bun test packages/http/e2e/compress.e2e.test.ts
import { afterAll, describe, expect, test } from 'bun:test';
import { resetLifecycle } from '@ultimat3/core';
import { defineHttpConfig } from '../src/config';
import { stream, textResponse } from '../src/response';
import type { Route } from '../src/router';
import { httpServer } from '../src/server';

const STYLESHEET = 'body { color: var(--color-text); }\n'.repeat(2_700);

const routes: readonly Route[] = [
  {
    method: 'GET',
    path: '/sheet.css',
    meta: { name: 'sheet', auth: 'public', cache: { mode: 'immutable' } },
    handler: () =>
      textResponse(STYLESHEET, { headers: { 'content-type': 'text/css; charset=utf-8' } }),
  },
  {
    method: 'GET',
    path: '/public-stream',
    meta: { name: 'public-stream', auth: 'public', cache: { mode: 'immutable' } },
    handler: () =>
      stream(new Blob([STYLESHEET]).stream(), { contentType: 'text/css; charset=utf-8' }),
  },
];

resetLifecycle();

const handle = httpServer({
  routes,
  role: 'web',
  config: defineHttpConfig({
    rateLimit: { scope: 'process' },
    port: 0,
    hostname: '127.0.0.1',
    dev: false,
  }),
}).start();

afterAll(async () => {
  await handle.stop();
  resetLifecycle();
});

const raw = (path: string, acceptEncoding: string): Promise<Response> =>
  fetch(`${handle.url()}${path}`, {
    decompress: false,
    headers: { 'accept-encoding': acceptEncoding },
  });

describe('what leaves the socket', () => {
  test('a public stylesheet is gzip on the wire, decodes to the source, and says so', async () => {
    const answer = await raw('/sheet.css', 'gzip, br');
    const wire = new Uint8Array(await answer.arrayBuffer());
    const source = new TextEncoder().encode(STYLESHEET);
    expect(answer.status).toBe(200);
    expect(answer.headers.get('content-encoding')).toBe('gzip');
    expect(answer.headers.get('content-length')).toBe(String(wire.byteLength));
    expect(wire.byteLength).toBe(Bun.gzipSync(source, { level: 6 }).byteLength);
    expect(wire.byteLength).toBeLessThan(source.byteLength / 2);
    expect(new TextDecoder().decode(Bun.gunzipSync(wire))).toBe(STYLESHEET);
    expect(answer.headers.get('vary')).toContain('accept-encoding');
  });

  test('a client that refused gzip gets every byte, identity, and the same vary', async () => {
    const answer = await raw('/sheet.css', 'identity');
    const wire = await answer.arrayBuffer();
    expect(answer.headers.get('content-encoding')).toBeNull();
    expect(wire.byteLength).toBe(new TextEncoder().encode(STYLESHEET).byteLength);
    expect(answer.headers.get('vary')).toContain('accept-encoding');
  });

  test('HEAD says what GET sends: the coded length, gzip, no body', async () => {
    const at = `${handle.url()}/sheet.css`;
    const headers = { 'accept-encoding': 'gzip' };
    // An immutable asset is recoded once in the background at gzip 9; until that lands a GET sends
    // the inline level-6 coding. Under load the recode landed between a GET and its HEAD, so wait
    // for the settled coding first: both must then describe the same bytes.
    const settled = Bun.gzipSync(new TextEncoder().encode(STYLESHEET), { level: 9 }).byteLength;
    const sent = async (): Promise<number> =>
      (await (await fetch(at, { decompress: false, headers })).arrayBuffer()).byteLength;
    let wire = await sent();
    // Each round trip is an event-loop turn the background coder can land in: no wall-clock wait.
    for (let tries = 0; wire !== settled && tries < 2_000; tries += 1) wire = await sent();
    expect(wire).toBe(settled);
    const head = await fetch(at, { method: 'HEAD', decompress: false, headers });
    expect(head.headers.get('content-encoding')).toBe('gzip');
    expect(head.headers.get('content-length')).toBe(String(wire));
    expect((await head.arrayBuffer()).byteLength).toBe(0);
  });

  // v31: coded as a stream, no length claimed — the bytes on the wire decode to the source.
  test('a public stream with no declared length leaves gzip, whole', async () => {
    const answer = await raw('/public-stream', 'gzip');
    expect(answer.headers.get('content-encoding')).toBe('gzip');
    expect(answer.headers.get('content-length')).toBeNull();
    const bytes = new Uint8Array(await answer.arrayBuffer());
    expect(new TextDecoder().decode(Bun.gunzipSync(bytes))).toBe(STYLESHEET);
  });
});
