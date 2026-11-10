// `include: 'exposed'` remembers what it saw, and the mount's question — "has anything exposed
// registered since?" — is answered against the live registries: an endpoint built too early is a
// coded refusal naming the tools it lacks, never a smaller catalog.
import { afterEach, describe, expect, test } from 'bun:test';
import { action, resetActions } from '@ultimat3/action';
import { registerAction } from '@ultimat3/action/loader';
import { allow } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { defineAppMcp } from './app-tools';
import { assertIncludeCurrent } from './include-early';
import { McpIncludeEarlyError } from './mount-errors';

afterEach(resetActions);

const exposedAction = (name: string): void => {
  registerAction(
    name,
    action({
      input: t.object({}),
      output: t.object({ ok: t.boolean }),
      policy: allow('posts:write'),
      mcp: { expose: true, description: `${name}, for the test` },
      handle: () => ({ ok: true }),
    }),
  );
};

const refusalOf = (run: () => void): McpIncludeEarlyError => {
  try {
    run();
  } catch (thrown) {
    if (thrown instanceof McpIncludeEarlyError) return thrown;
    throw thrown;
  }
  return expect.unreachable('the early catalog was accepted');
};

describe('assertIncludeCurrent', () => {
  test('an endpoint projected before an exposed action registered is X_MCP_INCLUDE_EARLY', () => {
    exposedAction('archivePost');
    const early = defineAppMcp({ include: 'exposed' });
    exposedAction('publishPost');
    const refused = refusalOf(() => assertIncludeCurrent(early, 'apps/admin/mcp.ts'));
    expect(refused.code).toBe('X_MCP_INCLUDE_EARLY');
    expect(refused.missing).toEqual(['publishPost']);
    expect(refused.cause).toContain('apps/admin/mcp.ts');
    expect(refused.fix).toContain('apps/admin/mcp.ts');
  });

  test('one projected after every registration passes', () => {
    exposedAction('publishPost');
    const current = defineAppMcp({ include: 'exposed' });
    expect(current.tools.map((tool) => tool.name)).toEqual(['publishPost']);
    expect(() => assertIncludeCurrent(current, 'apps/web/mcp.ts')).not.toThrow();
  });

  test('an endpoint that never asked for include, or a hand-built one, is not asked', () => {
    const written = defineAppMcp({});
    exposedAction('publishPost');
    expect(() => assertIncludeCurrent(written, 'apps/web/mcp.ts')).not.toThrow();
    expect(() =>
      assertIncludeCurrent({ server: {}, tools: [], route: undefined }, 'apps/web/mcp.ts'),
    ).not.toThrow();
  });
});
