import { describe, expect, test } from 'bun:test';
import type { Actor } from '@ultimat3/core';
import { UltimateError } from '@ultimat3/core';
import type { AnyMcpTool, McpCaller, McpToolResult } from './registry';
import { textResult } from './registry';
import { frameworkResources } from './resources';
import { createMcpServer } from './server';
import { INVALID_PARAMS, INVALID_REQUEST, METHOD_NOT_FOUND } from './wire';

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
    expect(response?.error?.message).toBe('tool not found: admin.only');
    // No enumeration behind the curtain: the answer must not hint that the tool exists.
    expect(JSON.stringify(response)).not.toContain('scope');
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

  const guarded = createMcpServer({ tools: [throwing, untitled] });

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
});
