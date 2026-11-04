// Each era's answer to each method, through `handle`: a legacy client negotiates on `initialize`
// exactly as before, a modern one is answered statelessly and stamped, and a version this server
// does not serve is the spec's `-32022` with what it does serve.

import { describe, expect, test } from 'bun:test';
import { agentActor } from '@ultimat3/core';
import * as mcpIndex from './index';
import { decodeHeader, eraOf, MCP_SUPPORTED_VERSIONS, METHODS } from './protocol-era';
import type { McpCaller } from './registry';
import { textResult } from './registry';
import { mcpServer } from './server';
import type { JsonRpcRequest, JsonRpcResponse } from './wire';
import {
  INVALID_PARAMS,
  MCP_LEGACY_VERSIONS,
  MCP_MODERN_VERSIONS,
  META_PROTOCOL_VERSION,
  META_SERVER_INFO,
  METHOD_NOT_FOUND,
  UNSUPPORTED_PROTOCOL_VERSION,
} from './wire';

/** The newest modern revision, as a caller now spells it. */
const MODERN = MCP_MODERN_VERSIONS[0];

const caller: McpCaller = { actor: agentActor({ id: 'a1' }), scopes: new Set(), role: 'member' };
const serverInfo = { name: 'era-test', version: '1.0.0' };

const server = mcpServer({
  serverInfo,
  instructions: 'read tools/list first',
  tools: [
    {
      name: 'echo',
      description: 'echoes',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      async handle() {
        return textResult('ok');
      },
    },
  ],
  resources: [
    {
      uri: 'ultimate://open',
      name: 'open',
      description: 'open',
      mimeType: 'text/plain',
      read: () => 'body',
    },
    {
      uri: 'ultimate://hidden',
      name: 'hidden',
      description: 'hidden',
      mimeType: 'text/plain',
      visibleTo: ['admin'],
      read: () => 'secret',
    },
  ],
});

const legacy = (method: string, params?: Record<string, unknown>): JsonRpcRequest => ({
  jsonrpc: '2.0',
  id: 1,
  method,
  ...(params === undefined ? {} : { params }),
});

const modern = (
  method: string,
  params: Record<string, unknown> = {},
  version: unknown = MODERN,
): JsonRpcRequest => ({
  jsonrpc: '2.0',
  id: 1,
  method,
  params: { ...params, _meta: { [META_PROTOCOL_VERSION]: version } },
});

const resultOf = (response: JsonRpcResponse | null): Record<string, unknown> =>
  (response?.result ?? {}) as Record<string, unknown>;

describe('the versions', () => {
  test('the newest served is the modern revision; three handshake revisions stay served', () => {
    expect(MODERN).toBe('2026-07-28');
    // Deleted, not repointed: its meaning changed, so a caller must choose an era by name.
    expect(Object.hasOwn(mcpIndex, 'MCP_PROTOCOL_VERSION')).toBe(false);
    expect([...MCP_MODERN_VERSIONS]).toEqual(['2026-07-28']);
    expect([...MCP_LEGACY_VERSIONS]).toEqual(['2025-11-25', '2025-06-18', '2025-03-26']);
    expect(MCP_SUPPORTED_VERSIONS).toEqual([...MCP_MODERN_VERSIONS, ...MCP_LEGACY_VERSIONS]);
  });

  test('the era is read from _meta, per request', () => {
    expect(eraOf(legacy('tools/list'))).toBe('legacy');
    expect(eraOf(modern('tools/list'))).toBe('modern');
    expect(eraOf(modern('tools/list', {}, '2025-06-18'))).toBe('legacy');
    expect(eraOf(modern('tools/list', {}, '1900-01-01'))).toEqual({ unsupported: '1900-01-01' });
    expect(eraOf(modern('tools/list', {}, 7))).toEqual({ unsupported: null });
  });
});

describe('legacy: initialize negotiates', () => {
  test.each(['2025-11-25', '2025-06-18', '2025-03-26'])('offering %s is echoed', async (v) => {
    const response = await server.handle(legacy('initialize', { protocolVersion: v }), caller);
    expect(resultOf(response)['protocolVersion']).toBe(v);
  });

  test('an unserved or absent offer falls back to the newest legacy revision', async () => {
    for (const params of [{ protocolVersion: '2024-11-05' }, { protocolVersion: '2026-07-28' }]) {
      const response = await server.handle(legacy('initialize', params), caller);
      expect(resultOf(response)['protocolVersion']).toBe('2025-11-25');
    }
    expect(resultOf(await server.handle(legacy('initialize'), caller))['protocolVersion']).toBe(
      '2025-11-25',
    );
  });

  test('a legacy result is not stamped, and ping still answers', async () => {
    const listed = resultOf(await server.handle(legacy('tools/list'), caller));
    expect(listed['resultType']).toBeUndefined();
    expect(listed['ttlMs']).toBeUndefined();
    expect(resultOf(await server.handle(legacy('ping'), caller))).toEqual({});
  });

  test('server/discover is a modern method', async () => {
    const response = await server.handle(legacy('server/discover'), caller);
    expect(response?.error?.code).toBe(METHOD_NOT_FOUND);
  });
});

describe('modern: stateless, stamped', () => {
  test('server/discover answers the versions, capabilities, identity and instructions', async () => {
    const result = resultOf(await server.handle(modern('server/discover'), caller));
    expect(result).toEqual({
      resultType: 'complete',
      supportedVersions: MCP_SUPPORTED_VERSIONS,
      capabilities: {
        tools: { listChanged: false },
        resources: { subscribe: false, listChanged: false },
        prompts: { listChanged: false },
      },
      instructions: 'read tools/list first',
      _meta: { [META_SERVER_INFO]: serverInfo },
      ttlMs: 0,
      cacheScope: 'private',
    });
  });

  test.each(['tools/list', 'prompts/list', 'resources/list', 'resources/templates/list'])(
    '%s is complete, carries serverInfo, and may not be shared',
    async (method) => {
      const result = resultOf(await server.handle(modern(method), caller));
      expect(result['resultType']).toBe('complete');
      expect(result['_meta']).toEqual({ [META_SERVER_INFO]: serverInfo });
      expect(result['ttlMs']).toBe(0);
      expect(result['cacheScope']).toBe('private');
    },
  );

  test('a tools/call result is stamped but carries no cache pair', async () => {
    const result = resultOf(await server.handle(modern('tools/call', { name: 'echo' }), caller));
    expect(result['resultType']).toBe('complete');
    expect(result['content']).toEqual([{ type: 'text', text: 'ok' }]);
    expect(result['ttlMs']).toBeUndefined();
  });

  test.each(['initialize', 'ping'])('%s is unknown to a modern request', async (method) => {
    const response = await server.handle(modern(method), caller);
    expect(response?.error?.code).toBe(METHOD_NOT_FOUND);
    expect(response?.error?.data).toEqual({ supported: METHODS.modern });
  });

  test('an unserved version is -32022 naming what is served', async () => {
    const response = await server.handle(modern('tools/list', {}, '1900-01-01'), caller);
    expect(response?.error?.code).toBe(UNSUPPORTED_PROTOCOL_VERSION);
    expect(response?.error?.data).toMatchObject({
      supported: MCP_SUPPORTED_VERSIONS,
      requested: '1900-01-01',
      code: 'X_MCP_PROTOCOL_UNSUPPORTED',
    });
  });
});

describe('resources/templates/list and resource not-found on both eras', () => {
  test('templates are an empty list on both eras', async () => {
    const old = resultOf(await server.handle(legacy('resources/templates/list'), caller));
    expect(old).toEqual({ resourceTemplates: [] });
    expect(resultOf(await server.handle(modern('resources/templates/list'), caller))).toMatchObject(
      { resourceTemplates: [] },
    );
  });

  test('hidden and absent are one answer: -32601 legacy, -32602 modern', async () => {
    for (const [build, code] of [
      [legacy, METHOD_NOT_FOUND],
      [modern, INVALID_PARAMS],
    ] as const) {
      const hidden = await server.handle(
        build('resources/read', { uri: 'ultimate://hidden' }),
        caller,
      );
      const absent = await server.handle(
        build('resources/read', { uri: 'ultimate://nope' }),
        caller,
      );
      expect(hidden?.error?.code).toBe(code);
      expect(JSON.stringify(hidden).replace('hidden', 'nope')).toBe(JSON.stringify(absent));
      expect(Object.keys(hidden?.error ?? {}).sort()).toEqual(['code', 'message']);
    }
  });
});

describe('decodeHeader', () => {
  test('the base64 sentinel decodes as UTF-8; a plain value is itself; broken base64 is nothing', () => {
    expect(decodeHeader('get_weather')).toBe('get_weather');
    expect(decodeHeader('=?base64?SGVsbG8sIOS4lueVjA==?=')).toBe('Hello, 世界');
    expect(decodeHeader('=?base64?PT9iYXNlNjQ/bGl0ZXJhbD89?=')).toBe('=?base64?literal?=');
    expect(decodeHeader('=?base64?%%%?=')).toBeUndefined();
  });
});
