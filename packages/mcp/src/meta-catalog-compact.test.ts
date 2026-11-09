// `catalogDetail: 'compact'` — the app's one choice of `list_resources` density. Full lists every
// action with its description and parameter hint; compact lists resource lines and action NAMES
// with their tags, and `describe_resource` carries the rest. Measured on a catalog shaped like the
// adopter that hand-raised its `list_resources` budget to 155,000 (≈46 resources, ≈330 actions).

import { describe, expect, test } from 'bun:test';
import { agentActor } from '@ultimat3/core';
import { renderCatalog } from './meta-catalog-render';
import type { McpResourceGroups } from './meta-surface';
import type { AnyMcpTool, McpCaller } from './registry';
import { textResult } from './registry';
import { mcpServer } from './server';
import { measureMcpSurface } from './surface-budget';

const caller: McpCaller = { actor: agentActor({ id: 'a' }), scopes: new Set(), role: 'staff' };

const VERBS = ['list', 'get', 'create', 'update', 'archive', 'publish', 'stats'] as const;

/**
 * 46 resources × 7 actions — the adopter's 46 and ~330 — named as its tools are (`flowRunStats`,
 * `uploadAsset`, `listRenders`: a verb and a short noun), described at its lengths.
 */
function adopterShaped(): { tools: AnyMcpTool[]; groups: McpResourceGroups } {
  const tools: AnyMcpTool[] = [];
  const groups: Record<string, { description: string; tools: string[] }> = {};
  for (let r = 0; r < 46; r += 1) {
    const noun = `asset${r}`;
    const names: string[] = [];
    for (const verb of VERBS) {
      const name = `${verb}${noun[0]?.toUpperCase()}${noun.slice(1)}`;
      names.push(name);
      tools.push({
        name,
        description: `${verb} the ${noun} records of the caller's workspace, with the filters a dashboard uses, newest first, paged by cursor; answers ids, titles, status and timestamps.`,
        destructive: verb !== 'list' && verb !== 'get' && verb !== 'stats',
        scope: `${noun}:${verb === 'list' || verb === 'get' ? 'read' : 'write'}`,
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            status: { type: 'string', enum: ['draft', 'live', 'archived'] },
            cursor: { type: 'string' },
            limit: { type: 'integer' },
            note: { type: 'string' },
          },
          required: ['id'],
          additionalProperties: false,
        },
        async handle() {
          return textResult('ok');
        },
      });
    }
    groups[`objects${r}`] = {
      description: `The ${noun} records and every verb an operator runs on them.`,
      tools: names,
    };
  }
  return { tools, groups };
}

describe("catalogDetail: 'compact'", () => {
  test('the adopter-shaped catalog fits 14,000 characters compact, and did not full', async () => {
    const { tools, groups } = adopterShaped();
    const full = await measureMcpSurface(mcpServer({ tools, groups, surface: 'meta' }), caller);
    const compact = await measureMcpSurface(
      mcpServer({ tools, groups, surface: 'meta', catalogDetail: 'compact' }),
      caller,
    );
    expect(full.listResources).toBeGreaterThan(60_000);
    // Measured 2026-11-09: full 95,318, compact 13,085.
    expect(compact.listResources).toBeLessThan(14_000);
  });

  test('compact keeps every action name and its tags, and names describe_resource', () => {
    const text = renderCatalog(
      [
        {
          name: 'cases',
          description: 'Court cases.',
          actions: [
            { name: 'listCases', kind: 'query', description: 'List.', params: 'q?: string' },
            {
              name: 'closeCase',
              kind: 'action',
              description: 'Close one.',
              params: 'id: string',
              confirms: true,
            },
          ],
        },
      ],
      'meta',
      'compact',
    );
    expect(text).toContain('cases — Court cases.');
    expect(text).toContain('  listCases; action: closeCase (confirms)');
    expect(text).not.toContain('Close one.');
    expect(text).not.toContain('id: string');
    expect(text.split('\n')[0]).toContain('describe_resource');
  });

  test('compact on a server no caller reads list_resources from is refused at boot', () => {
    expect(() => mcpServer({ catalogDetail: 'compact' })).toThrow(
      expect.objectContaining({ code: 'X_MCP_SURFACE_INVALID' }),
    );
  });

  test('a catalogDetail that is not one of the two is X_MCP_SURFACE_INVALID, whatever its type', () => {
    const { tools, groups } = adopterShaped();
    for (const detail of [10n, 'dense', Symbol('x')]) {
      expect(() =>
        mcpServer({
          tools,
          groups,
          surface: 'meta',
          catalogDetail: detail as unknown as 'compact',
        }),
      ).toThrow(expect.objectContaining({ code: 'X_MCP_SURFACE_INVALID' }));
    }
  });
});
