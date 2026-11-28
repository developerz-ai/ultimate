import { describe, expect, test } from 'bun:test';
// why: Bun ships no mkdtemp and no recursive remove.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { refreshKit } from './cmd-kit';
import { kitWarnings } from './doctor-kit';

const withApp = async (run: (root: string) => Promise<void>): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), 'x-kit-doctor-'));
  try {
    await Bun.write(join(root, 'package.json'), '{"name":"kitapp"}\n');
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

describe('unit · x doctor, the agent kit', () => {
  test('no marker is one warning naming the fix', async () => {
    await withApp(async (root) => {
      const warnings = await kitWarnings(root);
      expect(warnings.map((w) => [w.code, w.fix])).toEqual([['X_KIT_DRIFT', 'bunx x kit']]);
    });
  });

  test('a current kit says nothing; a drifted one names the file', async () => {
    await withApp(async (root) => {
      await refreshKit(root);
      expect(await kitWarnings(root)).toEqual([]);
      await Bun.write(join(root, '.claude/agents/shape.md'), 'edited\n');
      expect((await kitWarnings(root)).map((w) => w.at)).toEqual(['.claude/agents/shape.md']);
    });
  });
});
