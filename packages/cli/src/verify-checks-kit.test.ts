// The agent kit in the `manifest` step: errors once `.claude/kit.json` opts the app in, one warning
// until then — an app that passed yesterday never goes red for a rule it has not adopted.

import { describe, expect, test } from 'bun:test';
// why: Bun ships no mkdtemp and no recursive remove.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { refreshKit } from './cmd-kit';
import { VERIFY_STEPS } from './cmd-verify';
import { exec } from './exec';
import { KIT_MARKER } from './kit/registry';

const step = VERIFY_STEPS.find((candidate) => candidate.name === 'manifest');

const withApp = async (run: (root: string) => Promise<void>): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), 'x-kit-step-'));
  try {
    await Bun.write(join(root, 'app.config.ts'), "export const config = { name: 'kitapp' };\n");
    await Bun.write(join(root, 'package.json'), '{"name":"kitapp"}\n');
    await Bun.write(join(root, 'AGENTS.md'), '# kitapp\n');
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

const kitCodes = async (root: string): Promise<{ codes: string[]; warnings: string[] }> => {
  const outcome = await step?.run({ root, runner: exec });
  return {
    codes: (outcome?.findings ?? []).map((f) => f.code).filter((code) => code.startsWith('X_KIT')),
    warnings: (outcome?.warnings ?? []).filter((w) => w.includes(KIT_MARKER)),
  };
};

describe('unit · the manifest step and the agent kit', () => {
  test('no marker: one warning with the fix, no kit finding', async () => {
    await withApp(async (root) => {
      const { codes, warnings } = await kitCodes(root);
      expect(codes).toEqual([]);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('fix: bunx x kit');
    });
  });

  test('a marker and a refreshed kit: nothing', async () => {
    await withApp(async (root) => {
      await refreshKit(root);
      expect(await kitCodes(root)).toEqual({ codes: [], warnings: [] });
    });
  });

  test('a marker and an edited managed file: X_KIT_DRIFT', async () => {
    await withApp(async (root) => {
      await refreshKit(root);
      await Bun.write(join(root, '.claude/agents/audit.md'), 'my audit\n');
      expect((await kitCodes(root)).codes).toEqual(['X_KIT_DRIFT']);
    });
  });
});
