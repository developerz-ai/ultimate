// Pins which derived files the Stop hook checks for a set of changed paths, and that a second
// stop in a row (`stop_hook_active`) is never blocked — a hook that blocks forever is a hang.

import { describe, expect, test } from 'bun:test';
import { driftChecksFor, stopVerdict } from './stop-drift';

describe('which derived files a change can stale', () => {
  test('source under packages/ or scripts/ selects the framework manifest', () => {
    expect(driftChecksFor(['packages/core/src/errors.ts'])).toEqual(['manifest']);
    expect(driftChecksFor(['scripts/lib/tiers.ts'])).toEqual(['manifest']);
    expect(driftChecksFor(['packages/money/package.json'])).toEqual(['manifest']);
  });

  test('an entity or db change also selects the schema dumps', () => {
    expect(driftChecksFor(['examples/dummy/apps/web/app/posts/entity.ts'])).toEqual([
      'schema-dumps',
    ]);
    expect(driftChecksFor(['packages/db/src/client.ts'])).toEqual(['manifest', 'schema-dumps']);
  });

  test('docs, wiki and the harness select nothing', () => {
    expect(driftChecksFor(['docs/idea/02-primitives.md', 'wiki/Home.md', '.claude/x.md'])).toEqual(
      [],
    );
    expect(driftChecksFor([])).toEqual([]);
  });
});

describe('the verdict', () => {
  const stale = [{ check: 'manifest', fix: 'bun run manifest' }] as const;

  test('a stale derived file blocks the stop and names the command', () => {
    const verdict = stopVerdict({ stop_hook_active: false }, stale);
    expect(verdict?.decision).toBe('block');
    expect(verdict?.reason).toContain('bun run manifest');
  });

  test('a second stop in a row is let through, stale or not', () => {
    expect(stopVerdict({ stop_hook_active: true }, stale)).toBeUndefined();
  });

  test("a subagent stop is not the coordinator's gate", () => {
    expect(stopVerdict({ agent_type: 'feature-builder' }, stale)).toBeUndefined();
  });

  test('nothing stale: no verdict', () => {
    expect(stopVerdict({}, [])).toBeUndefined();
  });
});
