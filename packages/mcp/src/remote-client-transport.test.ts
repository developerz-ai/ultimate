// `mcpClient({ fetch })` as a production transport: it sits UNDER `outbound()`, so the client's own
// rules hold whatever it does. A transport that follows a redirect itself is refused, a long answer
// is cut by the client's `maxBytes` while the transport is still streaming it, and under
// `dial: 'public'` the screen runs before the transport is ever called — the transport is handed
// the approved address and `redirect: 'manual'`. Where it dials after that is the app's.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { markListening } from '@ultimat3/core';
import type { OutboundFetch } from '@ultimat3/core/outbound';
import { mcpClient } from './remote-client';

const failureOf = (promise: Promise<unknown>) =>
  promise.then(
    () => expect.unreachable('the call must refuse'),
    (error: unknown) =>
      error as {
        code: string;
        cause: string;
        meta?: Record<string, unknown>;
        sourceError?: { code?: string };
      },
  );

/** A server answering every call `ok`. */
const answering: OutboundFetch = async (_url, init) => {
  const { id } = JSON.parse(String(init.body)) as { id: number };
  return Response.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'ok' }] } });
};

let server: ReturnType<typeof Bun.serve> | undefined;
let unannounce = (): void => undefined;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: async (request) => {
      if (new URL(request.url).pathname === '/mcp') return Response.redirect('/elsewhere', 307);
      return answering(request.url, { body: await request.text() });
    },
  });
  unannounce = markListening(server.url.origin);
});

afterAll(() => {
  unannounce();
  server?.stop(true);
});

describe('mcpClient · a custom transport', () => {
  test('a transport that follows a redirect itself is still refused', async () => {
    const following: OutboundFetch = (url, init) =>
      fetch(url, { ...init, signal: init.signal ?? null, redirect: 'follow' } as RequestInit);
    const failure = await failureOf(
      mcpClient({
        name: 'peer',
        url: `${server?.url.origin ?? ''}/mcp`,
        dial: 'named',
        fetch: following,
      }).callTool('t', {}),
    );
    expect(failure.code).toBe('X_MCP_REMOTE_REFUSED');
    expect(failure.meta).toMatchObject({ failure: 'transport' });
    expect(failure.sourceError?.code).toBe('X_OUTBOUND_TRANSPORT_REDIRECTED');
  });

  test("a 5 MB answer is cut by the client's cap, while the transport still streams it", async () => {
    const chunk = new Uint8Array(64 * 1024).fill(0x20);
    const total = 5 * 1024 * 1024;
    let pulled = 0;
    let cancelled = false;
    const streaming: OutboundFetch = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (pulled >= total) return controller.close();
            pulled += chunk.length;
            controller.enqueue(chunk);
          },
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    const failure = await failureOf(
      mcpClient({
        name: 'peer',
        url: 'http://remote.test/mcp',
        dial: 'named',
        maxBytes: 1024 * 1024,
        fetch: streaming,
      }).callTool('t', {}),
    );
    expect(failure.code).toBe('X_MCP_REMOTE_REFUSED');
    expect(failure.meta).toMatchObject({ failure: 'transport' });
    expect(failure.sourceError?.code).toBe('X_OUTBOUND_TOO_LARGE');
    expect(failure.cause).toContain("past the client's byte cap");
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThan(total);
  });

  test('maxBytes must be a positive count', () => {
    expect(() =>
      mcpClient({ name: 'peer', url: 'http://remote.test/mcp', maxBytes: 0, fetch: answering }),
    ).toThrow();
  });

  test("under dial: 'public' the screen runs first; the transport gets the approved address", async () => {
    const seen: { url: string; redirect: RequestRedirect | undefined; host?: string }[] = [];
    const recording: OutboundFetch = (url, init) => {
      const headers = new Headers(init.headers);
      seen.push({ url, redirect: init.redirect, host: headers.get('host') ?? '' });
      return answering(url, init);
    };
    const peer = (url: string) => mcpClient({ name: 'peer', url, fetch: recording });

    const blocked = await failureOf(peer('https://127.0.0.1/mcp').callTool('t', {}));
    expect(blocked.sourceError?.code).toBe('X_OUTBOUND_HOST_BLOCKED');
    expect(seen).toEqual([]);

    expect(await peer('https://93.184.216.34/mcp').callTool('t', {})).toEqual({
      isError: false,
      text: 'ok',
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe('https://93.184.216.34/mcp');
    expect(seen[0]?.redirect).toBe('manual');
  });
});
