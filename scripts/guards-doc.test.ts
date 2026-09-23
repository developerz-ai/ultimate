// `docs/architecture/guards.md` is generated from the guards' own headers, and `--check` refuses a
// page that no longer says what they say.

import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
// why: Bun has no temp-directory native; each case needs a throwaway repo root on disk.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun ships no path-join primitive; Bun.write takes one already joined.
import { join } from 'node:path';
import {
  collectGuards,
  GUARDS_PAGE,
  guardsDocFindings,
  headerSentence,
  renderGuardsPage,
} from './guards-doc';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';

// The last case reads the real tree, so the file runs on the repo-scan backstop.
setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const GUARD = [
  '#!/usr/bin/env bun',
  '// Enforce, as a ratchet, that a `Record` is never read with a key',
  '// that is data. Second sentence is context.',
  '//',
  '// A later paragraph.',
  '',
  "const code = 'X_FAKE_GUARD';",
  "// 'X_IN_A_COMMENT' is prose, never a code the file emits",
  'if (import.meta.main) console.log(code);',
].join('\n');

const repo = async (files: Readonly<Record<string, string>>): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'guards-doc-'));
  roots.push(root);
  for (const [path, text] of Object.entries(files)) await Bun.write(join(root, path), text);
  return root;
};

describe('headerSentence', () => {
  test('the first sentence of the first paragraph, joined across comment lines', () => {
    expect(headerSentence(GUARD)).toBe(
      'Enforce, as a ratchet, that a `Record` is never read with a key that is data.',
    );
  });

  test('a file with no header comment has no sentence', () => {
    expect(headerSentence("const a = 'X_A';\n")).toBeUndefined();
  });
});

describe('collectGuards', () => {
  test('a runnable script that emits a code is a guard; its package.json name is the command', async () => {
    const root = await repo({
      'package.json': JSON.stringify({
        scripts: { 'fake-guard': 'bun run scripts/fake-guard.ts' },
      }),
      'scripts/fake-guard.ts': GUARD,
      'scripts/other.ts': GUARD.replace('fake', 'other'),
      'scripts/fake-guard.test.ts': GUARD,
      'scripts/lib/helper.ts': GUARD,
      'scripts/library.ts': "export const x = 'X_NOT_RUNNABLE';\n",
    });
    const guards = await collectGuards(root);
    expect(guards.map((guard) => guard.command)).toEqual([
      'bun run fake-guard',
      'bun run scripts/other.ts',
    ]);
    expect(guards[0]?.codes).toEqual(['X_FAKE_GUARD']);
  });
});

describe('--check', () => {
  test('a page that matches the headers is clean, and one edit to either side is drift', async () => {
    const root = await repo({ 'package.json': '{"scripts":{}}', 'scripts/g.ts': GUARD });
    const page = renderGuardsPage(await collectGuards(root));
    await Bun.write(join(root, GUARDS_PAGE), page);
    expect(await guardsDocFindings(root)).toEqual([]);

    await Bun.write(join(root, 'scripts/g.ts'), GUARD.replace('never read', 'not read'));
    const [finding] = await guardsDocFindings(root);
    expect(finding?.code).toBe('X_GUARDS_DOC_DRIFT');
    expect(finding?.fix).toBe('bun run scripts/guards-doc.ts --write');
  });

  test('no guard found at all is unscanned, never an empty page that passes', async () => {
    const root = await repo({ 'package.json': '{"scripts":{}}', 'scripts/lib/x.ts': GUARD });
    const [finding] = await guardsDocFindings(root);
    expect(finding?.code).toBe('X_GUARDS_DOC_UNSCANNED');
  });

  test('the committed page is what the tree generates', async () => {
    expect(await guardsDocFindings(repoRoot())).toEqual([]);
  });
});
