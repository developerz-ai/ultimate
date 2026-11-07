// `runtimeTool()` refuses at construction what must never be served: no permission, an undeclared
// one, a name outside MCP's alphabet, and a schema whose keywords `validateArgs` would not enforce.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { clearPermissions, definePermissions } from '@ultimat3/policy';
import type { RuntimeToolDefinition } from './runtime-tool';
import { builtRuntimeTool, runtimeTool } from './runtime-tool';

const base: RuntimeToolDefinition = {
  name: 'crm_search',
  description: 'Search the CRM. Read-only.',
  inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
  permission: 'connector:call',
  run: () => null,
};

beforeEach(() => definePermissions(['connector:call']));
afterEach(() => clearPermissions());

describe('runtimeTool', () => {
  test('builds a servable tool whose published schema is the one it enforces', () => {
    const tool = builtRuntimeTool(runtimeTool(base));
    expect(tool?.inputSchema).toEqual({ type: 'object', properties: { q: { type: 'string' } } });
    expect(tool?.destructive).toBe(true);
    expect(builtRuntimeTool({ name: 'crm_search', scope: undefined })).toBeUndefined();
  });

  test('a tool with no permission is X_MCP_TOOL_UNSAFE', () => {
    const unguarded = { ...base, permission: '' } as unknown as RuntimeToolDefinition;
    expect(() => runtimeTool(unguarded)).toThrow(/X_MCP_TOOL_UNSAFE/);
  });

  test('a permission nobody declared is refused by can(), never invented', () => {
    const invented = { ...base, permission: 'made:up' } as unknown as RuntimeToolDefinition;
    expect(() => runtimeTool(invented)).toThrow(/X_PERMISSION_UNKNOWN/);
  });

  test('a name outside MCP’s alphabet is refused', () => {
    for (const name of ['', 'has space', 'x'.repeat(129), 'drop;table']) {
      expect(() => runtimeTool({ ...base, name })).toThrow(/X_MCP_CATALOG_UNRESOLVED/);
    }
  });

  test('a keyword outside the wire subset is refused, never published unenforced', () => {
    const outside = [
      { type: 'object', properties: { at: { type: 'string', format: 'date-time' } } },
      { type: 'object', $ref: '#/defs/x' },
      { type: 'object', oneOf: [] },
      // A well-typed number under a keyword validateArgs does not enforce.
      { type: 'object', properties: { n: { type: 'number', multipleOf: 2 } } },
      { type: 'string' },
      { type: 'object', properties: { n: { type: 'number', minimum: Number.NaN } } },
      'not a schema',
    ];
    for (const inputSchema of outside) {
      expect(() => runtimeTool({ ...base, inputSchema })).toThrow(/X_MCP_CATALOG_UNRESOLVED/);
    }
  });

  test('a cyclic schema is refused by depth, not by a stack overflow', () => {
    const cyclic: Record<string, unknown> = { type: 'object' };
    cyclic['properties'] = { self: cyclic };
    expect(() => runtimeTool({ ...base, inputSchema: cyclic })).toThrow(/X_MCP_CATALOG_UNRESOLVED/);
  });

  test('a property named __proto__ stays a property', () => {
    const inputSchema = JSON.parse(
      '{"type":"object","properties":{"__proto__":{"type":"string"}}}',
    );
    const tool = builtRuntimeTool(runtimeTool({ ...base, inputSchema }));
    expect(Object.keys(tool?.inputSchema.properties ?? {})).toEqual(['__proto__']);
  });
});
