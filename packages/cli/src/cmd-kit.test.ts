// `x kit` against a real directory: it writes what is missing or differs, and nothing else.

import { describe, expect, test } from 'bun:test';
// why: Bun ships no mkdtemp and no recursive remove.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { refreshKit } from './cmd-kit';
import { KIT_ENTRIES, KIT_MARKER } from './kit/registry';

const withApp = async (run: (root: string) => Promise<void>): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), 'x-kit-'));
  try {
    await Bun.write(join(root, 'package.json'), '{"name":"kitapp"}\n');
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

const read = (root: string, path: string): Promise<string | undefined> =>
  Bun.file(join(root, path))
    .exists()
    .then((has) => (has ? Bun.file(join(root, path)).text() : undefined));

describe('unit · x kit', () => {
  test('writes every managed file and the marker, then is current', async () => {
    await withApp(async (root) => {
      const first = await refreshKit(root);
      expect(first.written).toHaveLength(KIT_ENTRIES.length + 1);
      expect(await read(root, KIT_MARKER)).toContain('"off"');
      const again = await refreshKit(root);
      expect(again.written).toEqual([]);
      expect(again.unchanged).toBe(KIT_ENTRIES.length);
    });
  });

  test('refreshes an edited file, never touches app-* files or DESIGN.md', async () => {
    await withApp(async (root) => {
      await refreshKit(root);
      await Bun.write(join(root, '.claude/agents/web.md'), 'edited\n');
      await Bun.write(join(root, '.claude/agents/app-web.md'), 'mine\n');
      await Bun.write(join(root, 'apps/web/DESIGN.md'), 'my design\n');
      const done = await refreshKit(root);
      expect(done.written).toEqual([{ path: '.claude/agents/web.md', action: 'updated' }]);
      expect(await read(root, '.claude/agents/app-web.md')).toBe('mine\n');
      expect(await read(root, 'apps/web/DESIGN.md')).toBe('my design\n');
    });
  });

  test('an entry listed in "off" is neither written nor rewritten', async () => {
    await withApp(async (root) => {
      await Bun.write(join(root, KIT_MARKER), '{"off":["audit"]}\n');
      const done = await refreshKit(root);
      expect(done.off).toEqual(['audit']);
      expect(await read(root, '.claude/agents/audit.md')).toBeUndefined();
      await Bun.write(join(root, '.claude/agents/audit.md'), 'mine\n');
      await refreshKit(root);
      expect(await read(root, '.claude/agents/audit.md')).toBe('mine\n');
    });
  });

  test('a command a skill shadows is left, reported with the git mv', async () => {
    await withApp(async (root) => {
      await Bun.write(join(root, '.claude/commands/feature.md'), 'old\n');
      const done = await refreshKit(root);
      expect(done.findings.map((f) => f.code)).toEqual(['X_KIT_SHADOWED']);
      expect(await read(root, '.claude/commands/feature.md')).toBe('old\n');
    });
  });

  test('an unreadable marker writes nothing', async () => {
    await withApp(async (root) => {
      await Bun.write(join(root, KIT_MARKER), 'nope');
      const done = await refreshKit(root);
      expect(done.written).toEqual([]);
      expect(done.findings.map((f) => f.code)).toEqual(['X_KIT_DRIFT']);
      expect(await read(root, '.claude/agents/web.md')).toBeUndefined();
    });
  });
});
