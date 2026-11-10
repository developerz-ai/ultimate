// `x upgrade` turns an adopter's `AGENTS.md` into a link only when it is byte-identical to
// `CLAUDE.md`; a different file is the author's to merge, so the hop reports it and leaves it.

import { afterEach, describe, expect, test } from 'bun:test';
// why: Bun has no lstat/readlink, temp-directory, symlink or recursive-remove API.
import { lstatSync, mkdtempSync, readlinkSync, rmSync, symlinkSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyAgentsLink, planAgentsLink } from './upgrade-agents-link';
import type { UpgradeHop } from './upgrade-plan';
import { humanLines, NO_WRITES, report } from './upgrade-report';

const dirs: string[] = [];
const app = async (files: Readonly<Record<string, string>>): Promise<string> => {
  const dir = mkdtempSync(join(tmpdir(), 'x-upgrade-agents-'));
  dirs.push(dir);
  for (const [path, text] of Object.entries(files)) await Bun.write(join(dir, path), text);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('unit · planAgentsLink', () => {
  test('identical regular files are linked, and the link is relative', async () => {
    const root = await app({ 'AGENTS.md': '# same\n', 'CLAUDE.md': '# same\n' });
    const state = await planAgentsLink(root);
    expect(state).toBe('link');
    await applyAgentsLink(root, state);
    expect(lstatSync(join(root, 'AGENTS.md')).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(root, 'AGENTS.md'))).toBe('CLAUDE.md');
    expect(await planAgentsLink(root)).toBe('linked');
  });

  test('different files are reported and never touched', async () => {
    const root = await app({ 'AGENTS.md': '# rules\n', 'CLAUDE.md': '# pointer\n' });
    const state = await planAgentsLink(root);
    expect(state).toBe('differs');
    await applyAgentsLink(root, state);
    expect(lstatSync(join(root, 'AGENTS.md')).isFile()).toBe(true);
    expect(await Bun.file(join(root, 'AGENTS.md')).text()).toBe('# rules\n');
  });

  test('a missing half is no pair', async () => {
    expect(await planAgentsLink(await app({ 'CLAUDE.md': 'x' }))).toBe('none');
    expect(await planAgentsLink(await app({ 'AGENTS.md': 'x' }))).toBe('none');
  });

  test.skipIf(process.platform === 'win32')('an existing link is left as it is', async () => {
    const root = await app({ 'CLAUDE.md': 'x' });
    symlinkSync('CLAUDE.md', join(root, 'AGENTS.md'));
    expect(await planAgentsLink(root)).toBe('linked');
  });
});

describe('unit · the hop reports it', () => {
  const hop: UpgradeHop = {
    from: '1.0.0',
    to: '2.0.0',
    next: null,
    atTarget: false,
    section: null,
  };
  const input = { hop, writes: NO_WRITES, gate: undefined, typescript: [] };
  // Shorthand: biome refuses a literal `then:` key, which reads as a thenable.
  const then = 'next';

  test('--json carries the state, and the terminal names the manual merge', () => {
    const json = report({
      ...input,
      done: false,
      dryRun: true,
      pins: [],
      bunFrom: null,
      bunTo: null,
      app: true,
      scripts: [],
      then,
      agentsMd: 'differs',
    }) as { readonly agentsMd: unknown };
    expect(json.agentsMd).toBe('differs');
    const lines = humanLines({ ...input, scripts: [], then, agentsMd: 'differs' });
    expect(lines.some((line) => line.includes('ln -sf CLAUDE.md AGENTS.md'))).toBe(true);
    const quiet = humanLines({ ...input, scripts: [], then, agentsMd: 'linked' });
    expect(quiet.some((line) => line.startsWith('AGENTS.md'))).toBe(false);
  });
});
