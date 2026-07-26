import { describe, expect, test } from 'bun:test';
import type { Actor } from '@ultimat3/core';
import type { AnyMcpTool, McpCaller } from './registry.ts';
import { textResult } from './registry.ts';
import { frameworkResources } from './resources.ts';
import { createMcpServer } from './server.ts';
import { INVALID_PARAMS, INVALID_REQUEST, METHOD_NOT_FOUND } from './wire.ts';

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
    const names = (listed?.result as { tools: { name: string }[] }).tools.map((t) => t.name);
    expect(names).toEqual(['open.tool', 'scoped.tool']);
    expect(names).not.toContain('admin.only');
  });

  test('tools/list includes it for a role that may see it', async () => {
    const listed = await server.handle(call('tools/list'), caller('admin', []));
    const names = (listed?.result as { tools: { name: string }[] }).tools.map((t) => t.name);
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
    expect((response?.error?.data as { code: string }).code).toBe('X_MCP_SCOPE_MISSING');
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
    expect((ok?.result as { content: { text: string }[] }).content[0]?.text).toBe('limit=10');

    const bad = await server.handle(
      call('tools/call', { name: 'scoped.tool', arguments: { limit: 0, nope: 1 } }),
      caller('member', ['db:read']),
    );
    expect(bad?.error?.code).toBe(INVALID_PARAMS);
    expect((bad?.error?.data as { issues: string[] }).issues).toEqual([
      'nope: unknown property',
      'limit: must be >= 1',
    ]);
  });

  test('resources/read returns the manifest at its stable URI', async () => {
    const response = await server.handle(
      call('resources/read', { uri: 'ultimate://manifest' }),
      caller(undefined, []),
    );
    const contents = (response?.result as { contents: { text: string }[] }).contents;
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
