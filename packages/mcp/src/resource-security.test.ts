// The three-outcome model on the RESOURCE surface — `security.test.ts`'s sibling for the other
// half of the wire.
//
// `resources/list` and `resources/read` took no caller at all until this file existed: any token
// `resolveToken` accepted could enumerate every URI and read every document, including the four
// the framework publishes — the manifest, the OpenAPI document, the route table and the entity
// schema, which together are an app's whole policy and data map. The 404 branch even answered the
// catalog in `data.available`, so a wrong guess enumerated it.
//
// Plus the fourth thing a resource owes: a provider is app code and may throw. `Bun.file(...).text()`
// on a missing `x.manifest.json` is an ENOENT, and it escaped `handle()` — `serveStdio` REJECTED
// with the raw error, zero frames written, the request unanswered and the session dead.

import { describe, expect, spyOn, test } from 'bun:test';
import { agentActor, UltimateError } from '@ultimat3/core';
import { defineAppMcp } from './app-tools';
import type { McpCaller } from './registry';
import type { McpResource } from './resources';
import { createMcpServer } from './server';
import type { JsonRpcResponse } from './wire';
import { INTERNAL_ERROR, INVALID_REQUEST, METHOD_NOT_FOUND } from './wire';

const caller = (role: string | undefined, scopes: readonly string[] = []): McpCaller => {
  const actor = agentActor({ id: 'agent-1' });
  return role === undefined
    ? { actor, scopes: new Set(scopes) }
    : { actor, scopes: new Set(scopes), role };
};

const anyone = caller(undefined);

const doc = (overrides: Partial<McpResource> & { uri: string }): McpResource => ({
  name: 'doc',
  description: 'a document',
  mimeType: 'application/json',
  read: () => '{"ok":true}',
  ...overrides,
});

const listed = (response: JsonRpcResponse | null): readonly string[] =>
  ((response?.result as { resources?: { uri: string }[] } | undefined)?.resources ?? []).map(
    (resource) => resource.uri,
  );

const readContents = (response: JsonRpcResponse | null): readonly { text: string }[] =>
  (response?.result as { contents?: { text: string }[] } | undefined)?.contents ?? [];

const errorData = (response: JsonRpcResponse | null): Record<string, unknown> =>
  (response?.error?.data ?? {}) as Record<string, unknown>;

const listRequest = { jsonrpc: '2.0' as const, id: 1, method: 'resources/list' };
const readRequest = (uri: string) => ({
  jsonrpc: '2.0' as const,
  id: 1,
  method: 'resources/read',
  params: { uri },
});

describe('outcome 1 — a resource the caller may not see is absent AND unreadable', () => {
  const server = createMcpServer({
    resources: [
      doc({ uri: 'ultimate://public' }),
      doc({ uri: 'ultimate://internal', visibleTo: ['admin'] }),
    ],
  });

  test('the catalog is filtered per caller', async () => {
    expect(listed(await server.handle(listRequest, anyone))).toEqual(['ultimate://public']);
    expect(listed(await server.handle(listRequest, caller('admin')))).toEqual([
      'ultimate://internal',
      'ultimate://public',
    ]);
  });

  test('reading a hidden URI answers exactly what an absent one answers', async () => {
    const hidden = await server.handle(readRequest('ultimate://internal'), anyone);
    const absent = await server.handle(readRequest('ultimate://nope'), anyone);
    expect(hidden?.error?.code).toBe(METHOD_NOT_FOUND);
    expect(absent?.error?.code).toBe(METHOD_NOT_FOUND);
    // One shape with the caller's own URI substituted, and no `data` on either: any field one
    // carries and the other does not is the difference a prober reads as "this exists".
    expect(hidden?.error?.message).toBe('resource not found: ultimate://internal');
    expect(absent?.error?.message).toBe('resource not found: ultimate://nope');
    expect(hidden?.error?.data).toBeUndefined();
    expect(absent?.error?.data).toBeUndefined();
  });

  test('the not-found answer carries no catalog — a wrong guess must enumerate nothing', async () => {
    const response = await server.handle(readRequest('ultimate://nope'), anyone);
    expect(errorData(response)['available']).toBeUndefined();
    expect(JSON.stringify(response)).not.toContain('ultimate://public');
  });

  test('a visible resource still reads', async () => {
    const response = await server.handle(readRequest('ultimate://internal'), caller('admin'));
    expect(readContents(response)[0]?.text).toBe('{"ok":true}');
  });
});

describe('outcome 2 — a resource the caller may see but whose scope the token lacks', () => {
  const server = createMcpServer({
    resources: [doc({ uri: 'ultimate://report', scope: 'report:read' })],
  });

  test('it stays in the catalog, because hiding it would strand a fixable client', async () => {
    expect(listed(await server.handle(listRequest, anyone))).toEqual(['ultimate://report']);
  });

  test('reading it is refused by NAME, never as not-found', async () => {
    const response = await server.handle(readRequest('ultimate://report'), anyone);
    expect(response?.error?.code).toBe(INVALID_REQUEST);
    expect(errorData(response)['code']).toBe('X_MCP_SCOPE_DENIED');
    expect(errorData(response)['scope']).toBe('report:read');
    expect(String(errorData(response)['fix'])).toContain('report:read');
  });

  test('a token carrying the scope reads it', async () => {
    const response = await server.handle(
      readRequest('ultimate://report'),
      caller(undefined, ['report:read']),
    );
    expect(readContents(response)[0]?.text).toBe('{"ok":true}');
  });
});

describe('a provider that throws is answered, never escaped', () => {
  class ManifestMissingError extends UltimateError {
    constructor() {
      super({
        code: 'X_MANIFEST_STALE',
        cause: 'x.manifest.json has not been generated',
        fix: 'x manifest --json',
      });
    }
  }

  const server = createMcpServer({
    resources: [
      doc({
        uri: 'ultimate://enoent',
        read: () => {
          throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
        },
      }),
      doc({
        uri: 'ultimate://coded',
        read: () => {
          throw new ManifestMissingError();
        },
      }),
      doc({
        uri: 'ultimate://hostile',
        read: () => {
          throw Object.create(null);
        },
      }),
    ],
  });

  test('an ENOENT comes back as -32603, not as a rejected handle()', async () => {
    const response = await server.handle(readRequest('ultimate://enoent'), anyone);
    expect(response?.error?.code).toBe(INTERNAL_ERROR);
    expect(response?.id).toBe(1);
    // No internals: the path a provider read is not the caller's business.
    expect(JSON.stringify(response)).not.toContain('no such file');
  });

  test('a framework error keeps its code, cause and fix, as tools/call already does', async () => {
    const response = await server.handle(readRequest('ultimate://coded'), anyone);
    expect(response?.error?.code).toBe(INTERNAL_ERROR);
    expect(errorData(response)['code']).toBe('X_MANIFEST_STALE');
    expect(errorData(response)['fix']).toBe('x manifest --json');
  });

  test('a thrown value that fights being read is still one answered frame', async () => {
    const response = await server.handle(readRequest('ultimate://hostile'), anyone);
    expect(response?.error?.code).toBe(INTERNAL_ERROR);
  });

  test('the next request on the same server is still served', async () => {
    await server.handle(readRequest('ultimate://enoent'), anyone);
    expect(listed(await server.handle(listRequest, anyone))).toHaveLength(3);
  });
});

/**
 * Every outcome is AUDITED, hidden included — the tool surface's rule, on the surface that owes
 * the same three outcomes. `resources/read` emitted nothing at all on any of them, so the one
 * refusal that tells a prober nothing (`not-found`, which is also `hidden`) left no trace
 * anywhere: enumeration is a pattern across many requests, and a URI walk over the four documents
 * that describe an app's whole policy and data map was invisible to the log the tool walk is
 * alerted from. `resources/list` is deliberately NOT audited, exactly as `tools/list` is not: it
 * is answered pre-filtered and reveals only what the caller may already see.
 */
describe('every resources/read outcome is audited, hidden included', () => {
  const server = createMcpServer({
    resources: [
      doc({ uri: 'ultimate://audit-public' }),
      doc({ uri: 'ultimate://audit-hidden', visibleTo: ['admin'] }),
      doc({ uri: 'ultimate://audit-scoped', scope: 'report:read' }),
      doc({
        uri: 'ultimate://audit-broken',
        read: () => {
          throw new UltimateError({
            code: 'X_MANIFEST_STALE',
            cause: 'x.manifest.json is older than the sources',
            fix: 'x manifest --json',
          });
        },
      }),
    ],
  });

  /**
   * The process logger's real output — the sink production writes to, not a stand-in. BOTH
   * streams: core's logger sends `error` to stderr and everything below it to stdout, and the
   * `failed` outcome is the one that lands on the other one.
   */
  async function captureLines(run: () => Promise<unknown>): Promise<Record<string, unknown>[]> {
    const lines: Record<string, unknown>[] = [];
    const collect = ((chunk: string) => {
      for (const line of String(chunk).split('\n')) {
        if (line.trim().length > 0) lines.push(JSON.parse(line) as Record<string, unknown>);
      }
      return true;
    }) as never;
    const spies = [
      spyOn(process.stdout, 'write').mockImplementation(collect),
      spyOn(process.stderr, 'write').mockImplementation(collect),
    ];
    try {
      await run();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    return lines;
  }

  test('a URI walk is visible in the log, at warn, whether it misses or is hidden', async () => {
    const missed = await captureLines(() =>
      server.handle(readRequest('ultimate://nothing-here'), anyone),
    );
    expect(missed).toHaveLength(1);
    expect(missed[0]).toMatchObject({
      level: 'warn',
      msg: 'mcp.resource-read.hidden',
      surface: 'mcp',
      resource: 'ultimate://nothing-here',
      outcome: 'hidden',
      actor: 'agent-1',
    });

    const hidden = await captureLines(() =>
      server.handle(readRequest('ultimate://audit-hidden'), anyone),
    );
    // Absent and hidden are ONE answer on the wire, and one line in the log too.
    expect(hidden[0]).toMatchObject({ msg: 'mcp.resource-read.hidden', outcome: 'hidden' });
  });

  test('a scope refusal names the scope it wanted', async () => {
    const lines = await captureLines(() =>
      server.handle(readRequest('ultimate://audit-scoped'), anyone),
    );
    expect(lines[0]).toMatchObject({
      level: 'warn',
      msg: 'mcp.resource-read.scope-denied',
      outcome: 'scope-denied',
      scope: 'report:read',
      code: 'X_MCP_SCOPE_DENIED',
    });
  });

  test('a read that succeeds is audited too, at info, with no document in the line', async () => {
    const lines = await captureLines(() =>
      server.handle(readRequest('ultimate://audit-public'), anyone),
    );
    expect(lines[0]).toMatchObject({
      level: 'info',
      msg: 'mcp.resource-read.ok',
      resource: 'ultimate://audit-public',
      outcome: 'ok',
    });
    // The decision, never the data it was made about.
    expect(JSON.stringify(lines)).not.toContain('{"ok":true}');
  });

  test('a provider that throws is the one outcome that is a bug, at error', async () => {
    const lines = await captureLines(() =>
      server.handle(readRequest('ultimate://audit-broken'), anyone),
    );
    expect(lines[0]).toMatchObject({
      level: 'error',
      msg: 'mcp.resource-read.failed',
      outcome: 'failed',
      code: 'X_MANIFEST_STALE',
    });
  });

  test('resources/list stays silent, exactly as tools/list does', async () => {
    expect(await captureLines(() => server.handle(listRequest, anyone))).toEqual([]);
  });
});

// A gate can only refuse what a declaration can reach: the registry half above proves the gate,
// this proves `defineAppMcp` carries the two fields to it.
describe('the declaration surface — defineAppMcp({ resources })', () => {
  const { server } = defineAppMcp({
    resources: [
      doc({ uri: 'ultimate://app-public' }),
      doc({ uri: 'ultimate://app-hidden', visibleTo: ['admin'] }),
      doc({ uri: 'ultimate://app-scoped', scope: 'report:read' }),
    ],
  });

  test('visibleTo survives the declaration', async () => {
    expect(listed(await server.handle(listRequest, anyone))).toEqual([
      'ultimate://app-public',
      'ultimate://app-scoped',
    ]);
  });

  test('scope survives the declaration', async () => {
    const denied = await server.handle(readRequest('ultimate://app-scoped'), anyone);
    expect(errorData(denied)['code']).toBe('X_MCP_SCOPE_DENIED');
    const allowed = await server.handle(
      readRequest('ultimate://app-scoped'),
      caller(undefined, ['report:read']),
    );
    expect(readContents(allowed)[0]?.text).toBe('{"ok":true}');
  });
});
