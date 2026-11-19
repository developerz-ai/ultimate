// `mcpClient()`'s outcomes, each distinguishable without reading a cause: a text-only success, a
// tool's own `isError`, no answer (`transport`), an HTTP refusal (`status`), a JSON-RPC `error`
// (`rpc`), a body that is no answer (`malformed`), a 401 (`X_MCP_REMOTE_AUTH_REQUIRED`). And a
// `tools/list_changed` notification makes `mcpTools()` hold the new list to the lock again.

import { describe, expect, test } from 'bun:test';
import { ctxOf, runWithContext, userActor } from '@ultimat3/core';
import { mcpClient } from './remote-client';
import { writeToolsLock } from './remote-lock';
import { mcpTools } from './remote-tools';
import { MCP_MODERN_VERSIONS } from './wire';

const URL = 'http://remote.test/mcp';
type Answer = (body: { id?: number; method: string }) => Response | Promise<Response>;

/** A modern-era server whose every answer `answer` decides. */
const serverOf = (answer: Answer) => async (_url: string, init: RequestInit) =>
  answer(JSON.parse(String(init.body)) as { id?: number; method: string });

const rpcResult = (id: number | undefined, result: unknown) =>
  Response.json({ jsonrpc: '2.0', id, result });

const client = (answer: Answer) =>
  mcpClient({ name: 'peer', url: URL, dial: 'named', fetch: serverOf(answer) });

const failureOf = (promise: Promise<unknown>) =>
  promise.then(
    () => expect.unreachable('the call must refuse'),
    (error: unknown) => error as { code: string; meta?: Record<string, unknown> },
  );

describe('mcpClient outcomes', () => {
  test('a text-only result with no structuredContent is a success', async () => {
    const answer = await client((body) =>
      rpcResult(body.id, { isError: false, content: [{ type: 'text', text: 'the quickstart' }] }),
    ).callTool('read_doc', { path: 'quickstart' });
    expect(answer).toEqual({ isError: false, text: 'the quickstart' });
  });

  test("a tool's own isError is a RESULT, not a refusal", async () => {
    const answer = await client((body) =>
      rpcResult(body.id, { isError: true, content: [{ type: 'text', text: 'no such doc' }] }),
    ).callTool('read_doc', {});
    expect(answer).toEqual({ isError: true, text: 'no such doc' });
  });

  test('no answer, an HTTP refusal, a JSON-RPC error and a non-answer are four failures', async () => {
    const down = mcpClient({
      name: 'peer',
      url: URL,
      dial: 'named',
      fetch: () => Promise.reject(new TypeError('connection refused')),
    });
    const kinds = await Promise.all([
      failureOf(down.callTool('t', {})),
      failureOf(client(() => new Response('busy', { status: 503 })).callTool('t', {})),
      failureOf(
        client((body) =>
          Response.json({ jsonrpc: '2.0', id: body.id, error: { code: -32603, message: 'x' } }),
        ).callTool('t', {}),
      ),
      failureOf(client(() => new Response('<html>hi</html>')).callTool('t', {})),
    ]);
    expect(kinds.map((error) => error.code)).toEqual([
      'X_MCP_REMOTE_REFUSED',
      'X_MCP_REMOTE_REFUSED',
      'X_MCP_REMOTE_REFUSED',
      'X_MCP_REMOTE_REFUSED',
    ]);
    expect(kinds.map((error) => error.meta?.['failure'])).toEqual([
      'transport',
      'status',
      'rpc',
      'malformed',
    ]);
  });

  test('a 401 is X_MCP_REMOTE_AUTH_REQUIRED naming the resource metadata', async () => {
    const failure = await failureOf(
      client(
        () =>
          new Response(null, {
            status: 401,
            headers: {
              'www-authenticate':
                'Bearer resource_metadata="http://remote.test/.well-known/oauth-protected-resource/mcp"',
            },
          }),
      ).listTools(),
    );
    expect(failure.code).toBe('X_MCP_REMOTE_AUTH_REQUIRED');
    expect(failure.meta?.['resourceMetadata']).toBe(
      'http://remote.test/.well-known/oauth-protected-resource/mcp',
    );
  });
});

describe('tools/list_changed', () => {
  test('mcpTools re-lists after the notification, and a drift then refuses the call', async () => {
    const tool = (property: string) => ({
      name: 'search',
      description: 'search',
      inputSchema: { type: 'object', properties: { [property]: { type: 'string' } } },
    });
    let listed = tool('q');
    let calls = 0;
    const fetch = serverOf((body) => {
      if (body.method === 'tools/list') return rpcResult(body.id, { tools: [listed] });
      calls += 1;
      // The answer rides an SSE stream that also carries the server's notification.
      const frames = [
        { jsonrpc: '2.0', method: 'notifications/tools/list_changed' },
        { jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: 'hit' }] } },
      ];
      return new Response(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(''), {
        headers: { 'content-type': 'text/event-stream' },
      });
    });
    const live = await mcpClient({ name: 'docs', url: URL, dial: 'named', fetch }).listTools();
    const lock = JSON.parse(writeToolsLock(undefined, 'docs', URL, ['search'], live)) as unknown;
    const { tools } = mcpTools({
      name: 'docs',
      url: URL,
      dial: 'named',
      fetch,
      allow: ['search'],
      policy: 'docs:search',
      lock,
    });
    const search = tools.get('search');
    const asUser = <T>(fn: () => Promise<T>) =>
      runWithContext(ctxOf({ actor: userActor({ id: 'u1', permissions: ['docs:search'] }) }), fn);
    expect(
      (await asUser(() => search?.({ q: 'a' }) ?? Promise.reject(new Error('no tool')))).isError,
    ).toBe(false);
    // The server changed its list and said so: the next call is held to the lock again.
    listed = tool('query');
    await expect(asUser(async () => search?.({ q: 'b' }))).rejects.toMatchObject({
      code: 'X_MCP_REMOTE_TOOL_CHANGED',
    });
    expect(calls).toBe(1);
  });
});

describe('the legacy GET stream', () => {
  /**
   * A 2025-era server: the modern request is an unknown version (-32022), `initialize` opens a
   * session, and a `GET` on the same URL is the stream it pushes its own messages on — or a 405.
   */
  const legacyServer = (stream: (signal: AbortSignal) => Response) => {
    const gets: (string | null)[] = [];
    const fetch = async (_url: string, init: RequestInit) => {
      if (init.method === 'GET') {
        gets.push(new Headers(init.headers).get('mcp-session-id'));
        return stream(init.signal ?? new AbortController().signal);
      }
      const body = JSON.parse(String(init.body)) as { id?: number; method: string };
      if (body.method === 'initialize') {
        return Response.json(
          { jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-06-18' } },
          { headers: { 'mcp-session-id': 'sess-1' } },
        );
      }
      if (body.id === undefined) return new Response(null, { status: 202 });
      if (new Headers(init.headers).get('mcp-session-id') === null) {
        return Response.json({
          jsonrpc: '2.0',
          id: body.id,
          error: { code: -32022, message: 'unsupported version' },
        });
      }
      return rpcResult(body.id, { tools: [] });
    };
    return { fetch, gets };
  };

  test('a list_changed pushed on the session stream is heard between calls', async () => {
    let changed!: () => void;
    const heard = new Promise<void>((resolve) => {
      changed = resolve;
    });
    const { fetch, gets } = legacyServer(
      () =>
        new Response(
          `data: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })}\n\n`,
          { headers: { 'content-type': 'text/event-stream' } },
        ),
    );
    const peer = mcpClient({
      name: 'old',
      url: URL,
      dial: 'named',
      fetch,
      onToolsChanged: changed,
    });
    await peer.listTools();
    await heard;
    expect(gets).toEqual(['sess-1']);
    peer.close();
  });

  test('a 405 is a server with no stream: never asked again; close() ends an open one', async () => {
    const refused = legacyServer(() => new Response(null, { status: 405 }));
    const once = mcpClient({
      name: 'old',
      url: URL,
      dial: 'named',
      fetch: refused.fetch,
      onToolsChanged: () => {},
    });
    await once.listTools();
    await once.listTools();
    await once.listTools();
    expect(refused.gets).toEqual(['sess-1']);

    let aborted!: () => void;
    const ended = new Promise<void>((resolve) => {
      aborted = resolve;
    });
    const held = legacyServer((signal) => {
      signal.addEventListener('abort', () => aborted(), { once: true });
      return new Response(new ReadableStream({ start() {} }), {
        headers: { 'content-type': 'text/event-stream' },
      });
    });
    const open = mcpClient({
      name: 'old',
      url: URL,
      dial: 'named',
      fetch: held.fetch,
      onToolsChanged: () => {},
    });
    await open.listTools();
    open.close();
    await ended;
    expect(held.gets).toEqual(['sess-1']);
  });
});

describe('the call itself', () => {
  test('an abort on a stream still open rejects with the caller’s own reason, never a refusal', async () => {
    const controller = new AbortController();
    const peer = mcpClient({
      name: 'peer',
      url: URL,
      dial: 'named',
      fetch: async (_url, init) => {
        // The headers arrive, the body never ends — until the caller gives up.
        const body = new ReadableStream<Uint8Array>({
          start(stream) {
            init.signal?.addEventListener('abort', () => stream.error(init.signal?.reason), {
              once: true,
            });
          },
        });
        queueMicrotask(() => controller.abort());
        return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
      },
    });
    const failure = await failureOf(peer.callTool('slow', {}, { signal: controller.signal }));
    // Outbound's rule: the caller's reason reaches the caller unchanged — not the server's fault.
    expect(failure).toBe(controller.signal.reason);
  });

  test('a redirect is refused, never followed, and the bearer is in no field of the error', async () => {
    const failure = await failureOf(
      mcpClient({
        name: 'peer',
        url: URL,
        dial: 'named',
        auth: () => ({ authorization: 'Bearer sk-live-secret' }),
        fetch: async () =>
          new Response(null, { status: 307, headers: { location: 'http://evil.test/mcp' } }),
      }).callTool('t', {}),
    );
    // Not followed: the 3xx itself is the answer, refused like any other status.
    expect(failure.code).toBe('X_MCP_REMOTE_REFUSED');
    expect(failure.meta).toMatchObject({ failure: 'status', status: 307 });
    expect(JSON.stringify(failure)).not.toContain('sk-live-secret');
  });

  test('a legacy call the caller aborts tells the server, by request id', async () => {
    const notices: unknown[] = [];
    const controller = new AbortController();
    const fetch = async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as {
        id?: number;
        method: string;
        params?: unknown;
      };
      if (body.method === 'notifications/cancelled') notices.push(body.params);
      if (body.method === 'initialize') {
        return Response.json(
          { jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-06-18' } },
          { headers: { 'mcp-session-id': 'sess-1' } },
        );
      }
      if (body.id === undefined) return new Response(null, { status: 202 });
      if (new Headers(init.headers).get('mcp-session-id') === null) {
        return Response.json({
          jsonrpc: '2.0',
          id: body.id,
          error: { code: -32022, message: 'v' },
        });
      }
      if (body.method === 'tools/list') return rpcResult(body.id, { tools: [] });
      controller.abort();
      return Promise.reject(controller.signal.reason);
    };
    const peer = mcpClient({ name: 'old', url: URL, dial: 'named', fetch });
    await peer.listTools();
    await failureOf(peer.callTool('slow', {}, { signal: controller.signal }));
    // Best effort and unawaited: let the notice's own request settle.
    for (let turn = 0; turn < 10 && notices.length === 0; turn += 1) await Promise.resolve();
    expect(notices).toEqual([{ requestId: 4 }]);
  });
});

describe('era negotiation and request ids', () => {
  /** A 2025-era server that counts its handshakes; `onCall` decides each session-bound call. */
  const legacyPeer = (onCall?: (id: number, method: string) => Promise<Response> | undefined) => {
    const seen = { initialize: 0, notices: [] as unknown[] };
    const fetch = async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as {
        id?: number;
        method: string;
        params?: unknown;
      };
      if (body.method === 'notifications/cancelled') seen.notices.push(body.params);
      if (body.method === 'initialize') {
        seen.initialize += 1;
        return Response.json(
          { jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-06-18' } },
          { headers: { 'mcp-session-id': 'sess-1' } },
        );
      }
      if (body.id === undefined) return new Response(null, { status: 202 });
      if (new Headers(init.headers).get('mcp-session-id') === null) {
        return Response.json({
          jsonrpc: '2.0',
          id: body.id,
          error: { code: -32022, message: 'v' },
        });
      }
      return onCall?.(body.id, body.method) ?? rpcResult(body.id, { tools: [], content: [] });
    };
    return { fetch, seen };
  };

  test('a cancelled call names its own requestId while a sibling call is in flight', async () => {
    const controller = new AbortController();
    const ids = new Map<string, number>();
    let releaseSibling!: () => void;
    const siblingHeld = new Promise<void>((resolve) => {
      releaseSibling = resolve;
    });
    let siblingPosted!: () => void;
    const siblingSent = new Promise<void>((resolve) => {
      siblingPosted = resolve;
    });
    const { fetch, seen } = legacyPeer((id, method) => {
      if (method !== 'tools/call') return undefined;
      if (ids.size === 0) {
        ids.set('slow', id);
        // The slow call is aborted only once its sibling has taken the next id.
        return siblingSent.then(() => {
          controller.abort();
          return Promise.reject(controller.signal.reason);
        });
      }
      ids.set('sibling', id);
      siblingPosted();
      return siblingHeld.then(() => rpcResult(id, { content: [] }));
    });
    const peer = mcpClient({ name: 'old', url: URL, dial: 'named', fetch });
    await peer.listTools();
    const slow = failureOf(peer.callTool('slow', {}, { signal: controller.signal }));
    await Promise.resolve();
    const sibling = peer.callTool('sibling', {});
    await slow;
    releaseSibling();
    await sibling;
    for (let turn = 0; turn < 10 && seen.notices.length === 0; turn += 1) await Promise.resolve();
    expect(seen.notices).toEqual([{ requestId: ids.get('slow') }]);
  });

  test('a call that finished before its signal aborted sends no cancellation', async () => {
    const controller = new AbortController();
    const { fetch, seen } = legacyPeer();
    const peer = mcpClient({ name: 'old', url: URL, dial: 'named', fetch });
    await peer.listTools();
    await peer.callTool('quick', {}, { signal: controller.signal });
    controller.abort();
    for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
    expect(seen.notices).toEqual([]);
  });

  test('a 429 on the first request is retried as modern, never latches legacy', async () => {
    let first = true;
    const methods: string[] = [];
    const peer = client((body) => {
      methods.push(body.method);
      if (first) {
        first = false;
        return new Response('slow down', { status: 429 });
      }
      if (body.method === 'initialize') {
        return Response.json({
          jsonrpc: '2.0',
          id: body.id,
          error: { code: -32601, message: 'm' },
        });
      }
      return rpcResult(body.id, { content: [{ type: 'text', text: 'ok' }] });
    });
    const failure = await failureOf(peer.callTool('t', {}));
    expect(failure.meta).toMatchObject({ failure: 'status', status: 429 });
    expect(await peer.callTool('t', {})).toEqual({ isError: false, text: 'ok' });
    expect(methods).toEqual(['tools/call', 'tools/call']);
  });

  test('a failed handshake leaves the era undecided: the next call tries modern again', async () => {
    let down = true;
    const sent: string[] = [];
    const peer = mcpClient({
      name: 'peer',
      url: URL,
      dial: 'named',
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init.body)) as { id?: number; method: string };
        const era = new Headers(init.headers).get('mcp-protocol-version');
        sent.push(`${body.method}@${String(era)}`);
        if (down) {
          if (body.method === 'initialize') down = false;
          return new Response('no', { status: 404 });
        }
        return rpcResult(body.id, { content: [{ type: 'text', text: 'ok' }] });
      },
    });
    await failureOf(peer.callTool('t', {}));
    expect(await peer.callTool('t', {})).toEqual({ isError: false, text: 'ok' });
    const modern = `tools/call@${MCP_MODERN_VERSIONS[0]}`;
    expect(sent).toEqual([modern, 'initialize@null', modern]);
  });

  test('two concurrent first calls to a legacy server open one session', async () => {
    const { fetch, seen } = legacyPeer();
    const peer = mcpClient({ name: 'old', url: URL, dial: 'named', fetch });
    await Promise.all([peer.listTools(), peer.listTools(), peer.callTool('t', {})]);
    expect(seen.initialize).toBe(1);
  });

  test('a cursor that never ends is refused, not truncated', async () => {
    let pages = 0;
    const failure = await failureOf(
      client((body) => {
        pages += 1;
        return rpcResult(body.id, {
          tools: [{ name: `t${String(pages)}` }],
          nextCursor: 'again',
        });
      }).listTools(),
    );
    expect(failure.code).toBe('X_MCP_REMOTE_REFUSED');
    expect(failure.meta?.['failure']).toBe('malformed');
  });
});
