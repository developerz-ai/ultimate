// `ui.diff`'s catalog entry, through a fake host. Its own file: `dev-server.test.ts` stands at the
// 500-line ceiling, and this tool is the one `ui.*` entry under the read scope, which is the fact
// worth pinning on its own.

import { describe, expect, test } from 'bun:test';
import type { Actor } from '@ultimat3/core';
import type { DevHost, UiDiffInput } from './dev-server';
import { DEV_SCOPES, devTools, UI_DIFF_DEFAULT_THRESHOLD } from './dev-server';
import type { McpCaller, McpToolResult } from './registry';
import { ToolRegistry } from './registry';

const agent = { kind: 'agent', id: 'a1' } as unknown as Actor;
const caller: McpCaller = { actor: agent, scopes: new Set([DEV_SCOPES.read]) };

const textOf = (result: McpToolResult | undefined): string | undefined => {
  const first = result?.content[0];
  return first?.type === 'text' ? first.text : undefined;
};

/** Only `diffShots` answers; every other capability is a fixture that must never be reached. */
function host(seen: UiDiffInput[]): DevHost {
  // `expect.unreachable`, never a bare `Error`: a capability this fixture was never meant to run
  // is a failed expectation about the catalog, and reports at the assertion.
  const refuse = (method: string) => () => expect.unreachable(`ui.diff fixture ran ${method}`);
  return {
    routes: () => [],
    entities: () => [],
    actions: () => [],
    queries: () => [],
    policies: () => [],
    jobs: () => [],
    jobInspect: () => ({}),
    database: { label: 'app_branch_x', branch: 'x', production: false },
    runQuery: refuse('runQuery'),
    runMigrations: refuse('runMigrations'),
    queueDepth: refuse('queueDepth'),
    runTests: refuse('runTests'),
    tailLogs: refuse('tailLogs'),
    readManifest: refuse('readManifest'),
    explainError: () => undefined,
    verify: refuse('verify'),
    shotRoute: refuse('shotRoute'),
    shotIsland: refuse('shotIsland'),
    inspectRoute: refuse('inspectRoute'),
    async diffShots(input: UiDiffInput) {
      seen.push(input);
      return {
        ok: true,
        before: input.before,
        after: input.after,
        width: 2,
        height: 2,
        changedPixels: 1,
        changedPercent: 25,
        changedBox: { x: 1, y: 1, width: 1, height: 1 },
        diff: '/app/.x/shot/diff-deadbeef.png',
      };
    },
  } as unknown as DevHost;
}

describe('unit · ui.diff is the read-class ui.* tool', () => {
  test('declared under dev:read, non-destructive, and billed as a read', () => {
    const seen: UiDiffInput[] = [];
    const tools = devTools(host(seen));
    const diff = tools.find((tool) => tool.name === 'ui.diff');
    if (diff === undefined) expect.unreachable('no ui.diff tool');
    expect(diff.scope).toBe(DEV_SCOPES.read);
    expect(diff.destructive).toBe(false);
    expect(diff.description).toContain('.x/shot/');
    expect(diff.description).toContain('no browser');
    const registry = new ToolRegistry().registerAll(tools);
    expect(registry.verbClass('ui.diff')).toBe('read');
    // The other three stay where they were: a browser is a write.
    expect(registry.verbClass('ui.shot')).toBe('write');
  });

  test('defaults the threshold, passes `out` only when it is a string, answers the host verbatim', async () => {
    const seen: UiDiffInput[] = [];
    const diff = devTools(host(seen)).find((tool) => tool.name === 'ui.diff');
    if (diff === undefined) expect.unreachable('no ui.diff tool');
    const result = await diff.handle({ before: '.x/shot/a.png', after: '.x/shot/b.png' }, caller);
    expect(seen).toEqual([
      { before: '.x/shot/a.png', after: '.x/shot/b.png', threshold: UI_DIFF_DEFAULT_THRESHOLD },
    ]);
    expect(result.isError).toBeUndefined();
    const answer = JSON.parse(textOf(result) ?? '{}') as { changedPercent: number; diff: string };
    expect(answer.changedPercent).toBe(25);
    expect(answer.diff).toBe('/app/.x/shot/diff-deadbeef.png');

    await diff.handle(
      { before: '.x/shot/a.png', after: '.x/shot/b.png', threshold: 0.4, out: '.x/shot/d.png' },
      caller,
    );
    expect(seen[1]).toEqual({
      before: '.x/shot/a.png',
      after: '.x/shot/b.png',
      threshold: 0.4,
      out: '.x/shot/d.png',
    });
  });
});
