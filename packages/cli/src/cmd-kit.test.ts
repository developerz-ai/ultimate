// `x kit` against a real directory: it writes what is missing or differs, and nothing else.

import { describe, expect, test } from 'bun:test';
// why: Bun ships no mkdtemp and no recursive remove.
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
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

  test('with a marker, a command a skill shadows is left, reported with the git mv', async () => {
    await withApp(async (root) => {
      await Bun.write(join(root, KIT_MARKER), '{"off":[]}\n');
      await Bun.write(join(root, '.claude/commands/feature.md'), 'old\n');
      const done = await refreshKit(root);
      expect(done.findings.map((f) => f.code)).toEqual(['X_KIT_SHADOWED']);
      expect(await read(root, '.claude/commands/feature.md')).toBe('old\n');
    });
  });

  test('with no marker, an edited legacy agent is kept as app-<name>.md before the managed one lands', async () => {
    await withApp(async (root) => {
      await Bun.write(
        join(root, '.claude/agents/data.md'),
        '---\nname: data\n---\nmy own data brief\n',
      );
      const done = await refreshKit(root);
      expect(await read(root, '.claude/agents/app-data.md')).toContain('my own data brief');
      expect(await read(root, '.claude/agents/app-data.md')).toContain('name: app-data');
      expect(await read(root, '.claude/agents/data.md')).toContain('Managed by Ultimate');
      expect(done.renamed.map((r) => r.path)).toEqual(['.claude/agents/app-data.md']);
    });
  });

  test("with a marker, an edit is the gate's to judge: nothing is renamed", async () => {
    await withApp(async (root) => {
      await refreshKit(root);
      await Bun.write(join(root, '.claude/agents/data.md'), 'edited\n');
      const done = await refreshKit(root);
      expect(done.renamed).toEqual([]);
      expect(await read(root, '.claude/agents/app-data.md')).toBeUndefined();
    });
  });

  test('with no marker, an edited legacy command is kept as app-<name>.md, so nothing shadows', async () => {
    await withApp(async (root) => {
      await Bun.write(join(root, '.claude/commands/feature.md'), 'mine\n');
      const done = await refreshKit(root);
      expect(await read(root, '.claude/commands/app-feature.md')).toBe('mine\n');
      expect(await read(root, '.claude/commands/feature.md')).toBeUndefined();
      expect(done.findings).toEqual([]);
    });
  });

  test('a managed file that is a symlink out of the app is refused, and the target untouched', async () => {
    await withApp(async (root) => {
      const outside = await mkdtemp(join(tmpdir(), 'x-kit-outside-'));
      try {
        await Bun.write(join(outside, 'secret'), 'keep me\n');
        await mkdir(join(root, '.claude/skills/feature'), { recursive: true });
        await symlink(join(outside, 'secret'), join(root, '.claude/skills/feature/SKILL.md'));
        await mkdir(join(root, '.claude'), { recursive: true });
        await mkdir(join(outside, 'agents'));
        await symlink(join(outside, 'agents'), join(root, '.claude/agents'));
        const done = await refreshKit(root);
        expect(await Bun.file(join(outside, 'secret')).text()).toBe('keep me\n');
        expect(await Bun.file(join(outside, 'agents/web.md')).exists()).toBe(false);
        const refused = done.findings.filter((f) => f.code === 'X_SCAFFOLD_PATH_ESCAPE');
        expect(refused.map((f) => f.at).sort()).toContain('.claude/skills/feature/SKILL.md');
        expect(refused.some((f) => f.at?.startsWith('.claude/agents/'))).toBe(true);
        // The files that stay inside the app are still written.
        expect(await read(root, '.claude/skills/verify/SKILL.md')).toContain('Managed by Ultimate');
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
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
