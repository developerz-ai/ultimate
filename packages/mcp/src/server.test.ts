import { describe, expect, test } from 'bun:test';
import type { Actor } from '@ultimat3/core';
import { UltimateError } from '@ultimat3/core';
import type { AnyMcpTool, McpCaller, McpToolResult } from './registry';
import { textResult } from './registry';
import { frameworkResources } from './resources';
import { createMcpServer } from './server';
import { INTERNAL_ERROR, INVALID_PARAMS, INVALID_REQUEST, METHOD_NOT_FOUND } from './wire';

const agent = { kind: 'agent', id: 'agent-1' } as unknown as Actor;

function caller(role: string | undefined, scopes: readonly string[]): McpCaller {
  return role === undefined
    ? { actor: agent, scopes: new Set(scopes) }
    : { actor: agent, scopes: new Set(scopes), role };
}

const openTool: AnyMcpTool = {
  name: 'open.tool',
  description: 'visible to everyone, needs no scope',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  async handle() {
    return textResult('ok');
  },
};

/** Hidden from `member`: exercises AXIS 1 (visibility → ToolNotFound). */
const adminOnly: AnyMcpTool = {
  name: 'admin.only',
  description: 'admins only',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  visibleTo: ['owner', 'admin'],
  destructive: true,
  async handle() {
    return textResult('admin ran');
  },
};

/** Visible to all roles but scope-gated: exercises AXIS 2 (scope → Forbidden). */
const scopeGated: AnyMcpTool = {
  name: 'scoped.tool',
  description: 'needs db:read',
  inputSchema: {
    type: 'object',
    properties: { limit: { type: 'integer', minimum: 1, default: 10 } },
    additionalProperties: false,
  },
  scope: 'db:read',
  async handle(args) {
    return textResult(`limit=${String(args['limit'])}`);
  },
};

const server = createMcpServer({
  tools: [openTool, adminOnly, scopeGated],
  resources: frameworkResources({ manifest: () => '{"version":1}' }),
});

const call = (method: string, params?: unknown) =>
  params === undefined
    ? { jsonrpc: '2.0' as const, id: 1, method }
    : { jsonrpc: '2.0' as const, id: 1, method, params };

describe('the envelope refusals carry the fix', () => {
  test('a batch (an array) is refused by name, with one request per message as the fix', async () => {
    const response = await server.handle(
      [call('tools/list'), call('tools/list')],
      caller('member', []),
    );
    expect(response?.id).toBeNull();
    expect(response?.error?.code).toBe(INVALID_REQUEST);
    expect(response?.error?.message).toContain('batch');
    const data = response?.error?.data as { code: string; fix: string };
    expect(data.code).toBe('X_MCP_PROTOCOL');
    // No wire named, no unit spelled: the server does not know it is mounted at `/mcp`, or at
    // all — `mcpHttpRoute({ path })` is a knob, and a spelled `/mcp` was wrong for `/app-mcp`.
    expect(data.fix).toContain('one request per message');
    expect(data.fix).not.toContain('/mcp');
  });

  test('the batch fix names the unit the wire counts in, when the transport says which', async () => {
    const batch = [call('tools/list'), call('tools/list')];
    const http = await server.handle(batch, caller('member', []), {
      transport: 'http',
      path: '/app-mcp',
    });
    const httpFix = (http?.error?.data as { fix: string } | undefined)?.fix;
    expect(httpFix).toContain('one request per POST /app-mcp');
    const stdio = await server.handle(batch, caller('member', []), { transport: 'stdio' });
    const stdioFix = (stdio?.error?.data as { fix: string } | undefined)?.fix;
    expect(stdioFix).toContain('one request per line');
    // The `message` is the same sentence on every wire; only the fix carries the unit.
    expect(http?.error?.message).toBe(stdio?.error?.message);
  });

  test('a non-envelope names the shape a JSON-RPC 2.0 request has', async () => {
    const response = await server.handle({ not: 'jsonrpc' }, caller('member', []));
    expect(response?.error?.code).toBe(INVALID_REQUEST);
    expect(response?.error?.message).toBe('not a JSON-RPC 2.0 request envelope');
    const data = response?.error?.data as { code: string; fix: string };
    expect(data.code).toBe('X_MCP_PROTOCOL');
    expect(data.fix).toContain("jsonrpc: '2.0'");
  });
});

describe('hidden is not forbidden', () => {
  test('tools/list omits a tool hidden from the caller role', async () => {
    const listed = await server.handle(call('tools/list'), caller('member', ['db:read']));
    const result = listed?.result as { tools: { name: string }[] } | undefined;
    expect(result).toBeDefined();
    const names = (result?.tools ?? []).map((t) => t.name);
    expect(names).toEqual(['open.tool', 'scoped.tool']);
    expect(names).not.toContain('admin.only');
  });

  test('tools/list includes it for a role that may see it', async () => {
    const listed = await server.handle(call('tools/list'), caller('admin', []));
    const result = listed?.result as { tools: { name: string }[] } | undefined;
    expect(result).toBeDefined();
    const names = (result?.tools ?? []).map((t) => t.name);
    expect(names).toContain('admin.only');
  });

  test('calling a role-hidden tool answers ToolNotFound, never Forbidden', async () => {
    const response = await server.handle(
      // Every scope in the world: proves the answer is about VISIBILITY, not capability.
      call('tools/call', { name: 'admin.only', arguments: {} }),
      caller('member', ['db:read', 'dev:read', 'db:migrate']),
    );
    expect(response?.error?.code).toBe(METHOD_NOT_FOUND);
    // The message carries the ONE instruction that is safe on both branches — read `tools/list`
    // — because a hidden tool and an absent one answer it identically, and neither says which.
    // Measured through ai-maxxing's `POST /mcp` on 2026-09-07: `tool not found: <name>` and
    // nothing else, so a box agent holding a stale name had no next step.
    expect(response?.error?.message).toBe(
      'tool not found: admin.only — call tools/list to read the catalog this caller may use',
    );
    expect(response?.error?.data).toBeUndefined();
    // No enumeration behind the curtain: the answer must not hint that the tool exists.
    expect(JSON.stringify(response)).not.toContain('scope');
  });

  test('an absent tool answers the same instruction, so the hint reveals nothing', async () => {
    const absent = await server.handle(
      call('tools/call', { name: 'no.such.tool', arguments: {} }),
      caller('member', []),
    );
    expect(absent?.error?.message).toBe(
      'tool not found: no.such.tool — call tools/list to read the catalog this caller may use',
    );
    expect(absent?.error?.data).toBeUndefined();
  });

  test('a visible tool with a missing scope answers Forbidden, not ToolNotFound', async () => {
    const response = await server.handle(
      call('tools/call', { name: 'scoped.tool', arguments: {} }),
      caller('member', []),
    );
    expect(response?.error?.code).toBe(INVALID_REQUEST);
    expect(response?.error?.message).toBe('missing scope: db:read');
    const data = response?.error?.data as { code: string; fix: string } | undefined;
    expect(data?.code).toBe('X_MCP_SCOPE_DENIED');
    // The caller can legitimately fix this, so the refusal names the scope and where it comes
    // from. Not `x token grant` — that command is planned and exits X_NOT_IMPLEMENTED.
    expect(data?.fix).toContain('"db:read"');
    expect(data?.fix).toContain('resolveToken(token)');
  });
});

describe('dispatch', () => {
  test('initialize advertises the protocol version and three capabilities', async () => {
    const response = await server.handle(call('initialize'), caller(undefined, []));
    const result = response?.result as {
      protocolVersion: string;
      capabilities: Record<string, unknown>;
    };
    expect(result.protocolVersion).toBe('2025-06-18');
    expect(Object.keys(result.capabilities).sort()).toEqual(['prompts', 'resources', 'tools']);
  });

  test('a notification (no id) produces no response at all', async () => {
    const response = await server.handle(
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      caller(undefined, []),
    );
    expect(response).toBeNull();
  });

  test('args are validated against the schema the agent was handed, with defaults applied', async () => {
    const ok = await server.handle(
      call('tools/call', { name: 'scoped.tool', arguments: {} }),
      caller('member', ['db:read']),
    );
    const okResult = ok?.result as { content: { text: string }[] } | undefined;
    expect(okResult?.content[0]?.text).toBe('limit=10');

    const bad = await server.handle(
      call('tools/call', { name: 'scoped.tool', arguments: { limit: 0, nope: 1 } }),
      caller('member', ['db:read']),
    );
    expect(bad?.error?.code).toBe(INVALID_PARAMS);
    const badData = bad?.error?.data as { issues: string[] } | undefined;
    expect(badData?.issues).toEqual(['nope: unknown property', 'limit: must be >= 1']);
  });

  test('resources/read returns the manifest at its stable URI', async () => {
    const response = await server.handle(
      call('resources/read', { uri: 'ultimate://manifest' }),
      caller(undefined, []),
    );
    const resourceResult = response?.result as { contents: { text: string }[] } | undefined;
    expect(resourceResult).toBeDefined();
    const contents = resourceResult?.contents ?? [];
    expect(contents[0]?.text).toBe('{"version":1}');
  });

  test('rate-limit class is read for chatter and write for a destructive tool', () => {
    expect(server.classify(call('initialize'))).toBe('read');
    expect(server.classify(call('tools/list'))).toBe('read');
    expect(server.classify(call('tools/call', { name: 'scoped.tool' }))).toBe('read');
    expect(server.classify(call('tools/call', { name: 'admin.only' }))).toBe('write');
    // Fail-closed: an unresolvable call pays the strict bucket.
    expect(server.classify(call('tools/call', {}))).toBe('write');
  });
});

describe('a framework error reaches the model in the shape the terminal prints', () => {
  const denial = new UltimateError({
    code: 'X_FORBIDDEN',
    cause: 'refundOrder denied: actor lacks order:refund',
    fix: 'x policy explain refundOrder --json',
  });

  const throwing: AnyMcpTool = {
    name: 'orders.refund',
    description: 'throws a real UltimateError, exactly as guard() throws it',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async handle(): Promise<McpToolResult> {
      throw denial;
    },
  };

  /** A foreign object with `code`/`cause`/`fix` but no title — the fallback branch. */
  const untitled: AnyMcpTool = {
    name: 'orders.void',
    description: 'throws a foreign coded object',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async handle(): Promise<McpToolResult> {
      throw { code: 'X_FOREIGN', cause: 'a package that is not core threw', fix: 'x doctor' };
    },
  };

  /** A foreign object carrying a code and no `fix` at all — the substituted-fix branch. */
  const unfixed: AnyMcpTool = {
    name: 'orders.reopen',
    description: 'throws a coded object with no fix',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async handle(): Promise<McpToolResult> {
      throw { code: 'X_FOREIGN', cause: 'a package that is not core threw' };
    },
  };

  const guarded = createMcpServer({ tools: [throwing, untitled, unfixed] });

  const textOf = async (name: string): Promise<string> => {
    const response = await guarded.handle(
      call('tools/call', { name, arguments: {} }),
      caller(undefined, []),
    );
    const result = response?.result as { content: { text: string }[] } | undefined;
    return result?.content[0]?.text ?? '';
  };

  test('the rendering IS UltimateError.format(), byte for byte', async () => {
    // Pinned against `format()` itself rather than a literal: asserting the string shape
    // alone would keep passing after the canonical rendering moved, which is the drift this
    // test exists to catch.
    expect(await textOf('orders.refund')).toBe(denial.format());
    expect(denial.format().split('\n')[0]).toBe(`X_FORBIDDEN: ${denial.title}`);
  });

  test('a thrown object with no title falls back to the bare code, still three lines', async () => {
    expect(await textOf('orders.void')).toBe(
      'X_FOREIGN\n  cause: a package that is not core threw\n  fix:   x doctor',
    );
  });

  // The substituted fix is the one line in this rendering nobody wrote for the reader, so it is
  // the one most likely to be a shrug. `see docs` is the phrase the repo's own fix rule bans —
  // it survived only because BANNED_PHRASES spells it `see the docs`, one article longer.
  /**
   * The substituted fix interpolates `code` into a COMMAND, and `startsWith('X_')` was the whole
   * of the guard in front of it — so a thrown object naming itself `X_$(id)` produced
   * `fix: x errors explain X_$(id)`, a command substitution in the line an agent is told to run.
   * Core's `FRAMEWORK_CODE` is the one spelling of a code, and a value that is not one is not a
   * framework error at all: `-32603`, with nothing of the throw leaked.
   */
  test('a code that is not a code spelled the one way is never rendered into a command', async () => {
    for (const code of ['X_$(id)', 'X_`id`', 'X_a;rm -rf ~', 'X_ ', 'X_lower']) {
      const rogue: AnyMcpTool = {
        name: 'orders.rogue',
        description: 'throws an object whose code is not a code',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        handle: () => Promise.reject({ code, cause: 'a package that is not core threw' }),
      };
      const server = createMcpServer({ tools: [rogue] });
      const response = await server.handle(
        call('tools/call', { name: 'orders.rogue', arguments: {} }),
        caller(undefined, []),
      );
      expect(response?.error?.code).toBe(INTERNAL_ERROR);
      expect(JSON.stringify(response)).not.toContain(code);
    }
  });

  test('a coded object with no fix is given a runnable one, never a shrug', async () => {
    const text = await textOf('orders.reopen');

    expect(text).toBe(
      'X_FOREIGN\n  cause: a package that is not core threw\n  fix:   x errors explain X_FOREIGN',
    );
    expect(text).not.toContain('see docs');
  });
});

// The transport's promise for anything that is NOT a framework error: `-32603`, no internals
// leaked. It is reached past four property reads of a value an app's handler threw — a getter
// call, or a `Proxy` trap — so the probe can raise where the catch block has nothing left to
// answer with, and the JSON-RPC request then dies with no response at all.
describe('a throw that fights being read is still an answer, never an escape', () => {
  const hostile = (value: unknown): AnyMcpTool => ({
    name: 'orders.hostile',
    description: 'throws a value that traps every read',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handle: () => Promise.reject(value),
  });

  test.each([
    [
      'a Proxy trapping get and getPrototypeOf',
      new Proxy(
        {},
        {
          get() {
            throw new Error('trapped get');
          },
          getPrototypeOf() {
            throw new Error('trapped getPrototypeOf');
          },
        },
      ) as unknown,
    ],
    [
      'an object whose code getter throws',
      Object.defineProperty({}, 'code', {
        get() {
          throw new Error('trapped code');
        },
        enumerable: true,
      }) as unknown,
    ],
    ['a symbol', Symbol('thrown') as unknown],
  ])('%s becomes -32603, with the tool named and nothing leaked', async (_label, value) => {
    const server = createMcpServer({ tools: [hostile(value)] });
    const response = await server.handle(
      call('tools/call', { name: 'orders.hostile', arguments: {} }),
      caller(undefined, []),
    );
    const error = response?.error;
    expect(error?.code).toBe(INTERNAL_ERROR);
    expect(error?.message).toBe('tool "orders.hostile" failed unexpectedly');
  });

  // A null-prototype coded object is what a worker or a JSON round trip produces, and it still
  // renders — the discriminator is the FIELD, never the prototype.
  test('a null-prototype coded object still renders its three lines', async () => {
    const flattened = Object.assign(Object.create(null), {
      code: 'X_FOREIGN',
      cause: 'a worker sent this back',
      fix: 'x doctor',
    });
    const server = createMcpServer({ tools: [hostile(flattened)] });
    const response = await server.handle(
      call('tools/call', { name: 'orders.hostile', arguments: {} }),
      caller(undefined, []),
    );
    const result = response?.result as
      | { content: { text: string }[]; isError?: boolean }
      | undefined;
    expect(result?.isError).toBe(true);
    expect(result?.content[0]?.text).toBe(
      'X_FOREIGN\n  cause: a worker sent this back\n  fix:   x doctor',
    );
  });
});

/**
 * `code` on a tool's own `isError` result is an AUDIT field. It exists so a tool that renders its
 * own refusal (`@ultimat3/admin` does) is classified by the same `outcomeForCode` a THROWN error
 * is, instead of every refusal landing in the `policy-denied` bucket a prober's name walk is
 * alerted from. It must never reach the wire — the code is already inside the rendered body.
 */
describe('a self-rendered refusal names its code for the audit, never for the caller', () => {
  const selfRefusing: AnyMcpTool = {
    name: 'admin.create',
    description: 'renders its own refusal',
    inputSchema: { type: 'object', properties: {}, additionalProperties: true },
    async handle(): Promise<McpToolResult> {
      return {
        content: [{ type: 'text', text: '{"error":"X_ADMIN_INVALID"}' }],
        isError: true,
        code: 'X_ADMIN_INVALID',
      };
    },
  };

  test('the result carries content and isError, and no third key', async () => {
    const self = createMcpServer({ tools: [selfRefusing] });
    const response = await self.handle(
      call('tools/call', { name: 'admin.create', arguments: {} }),
      caller(undefined, []),
    );
    const result = response?.result as Record<string, unknown> | undefined;
    expect(Object.keys(result ?? {}).sort()).toEqual(['content', 'isError']);
    expect(result?.['isError']).toBe(true);
  });
});
