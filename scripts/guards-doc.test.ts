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

  test('a code raised in a scripts/lib module the guard imports is the guard’s code too', async () => {
    const root = await repo({
      'package.json': '{}',
      'scripts/fake-guard.ts': [
        "import { pair } from './lib/pairing';",
        "import type { Shape } from './lib/shape';",
        "import { parseScriptArgs } from './lib/args';",
        "import { PINS } from './lib/fake-pins';",
        "// import { x } from './lib/in-a-comment';",
        GUARD,
      ].join('\n'),
      'scripts/lib/pairing.ts':
        "import { deep } from './deep';\nexport const pair = 'X_LIB_PAIRED';\n",
      'scripts/lib/shape.ts': "export type Shape = 'X_TYPE_ONLY_STILL_READ';\n",
      'scripts/lib/in-a-comment.ts': "export const x = 'X_NEVER_IMPORTED';\n",
      // One level only: a module the lib module imports is not read.
      'scripts/lib/deep.ts': "export const deep = 'X_TWO_LEVELS_DOWN';\n",
      // Shared infrastructure and pin tables contribute nothing to a row.
      'scripts/lib/args.ts': "export const args = 'X_CLI_BAD_FLAG';\n",
      'scripts/lib/fake-pins.ts':
        "export const PINS = { x: { reason: 'see X_NAMED_IN_PROSE' } };\n",
    });
    const [guard] = await collectGuards(root);
    expect(guard?.codes).toEqual(['X_FAKE_GUARD', 'X_LIB_PAIRED', 'X_TYPE_ONLY_STILL_READ']);
  });

  test('a side-effect import of a lib module counts as much as a named one', async () => {
    const root = await repo({
      'package.json': '{}',
      'scripts/fake-guard.ts': `import './lib/registers';\nimport"./lib/tight";\n${GUARD}`,
      'scripts/lib/registers.ts': "throw { code: 'X_SIDE_EFFECT_RULE' };\n",
      'scripts/lib/tight.ts': "export const t = 'X_NO_SPACE';\n",
    });
    expect((await collectGuards(root))[0]?.codes).toEqual([
      'X_FAKE_GUARD',
      'X_NO_SPACE',
      'X_SIDE_EFFECT_RULE',
    ]);
  });

  test('a lib module that does not exist adds nothing and breaks nothing', async () => {
    const root = await repo({
      'package.json': '{}',
      'scripts/fake-guard.ts': `import { gone } from './lib/gone';\n${GUARD}`,
    });
    expect((await collectGuards(root))[0]?.codes).toEqual(['X_FAKE_GUARD']);
  });

  test('the real changelog-check row lists the pairing codes from lib/changelog-pairing.ts', async () => {
    const guard = (await collectGuards(repoRoot())).find(
      (one) => one.file === 'scripts/changelog-check.ts',
    );
    expect(guard?.codes).toContain('X_DOC_MIGRATION_UNPAIRED');
    expect(guard?.codes).toContain('X_DOC_MIGRATION_RANGE_STALE');
  });
});

describe('the listed command is the form that REPORTS', () => {
  const usage = (line: string): string =>
    GUARD.replace('//\n// A later paragraph.', `//\n//   ${line}`);

  test('a guard whose usage offers a bare [--check] writes by default, so the page lists --check', async () => {
    const root = await repo({
      'package.json': JSON.stringify({ scripts: { dumps: 'bun run scripts/dumps.ts' } }),
      'scripts/dumps.ts': usage('bun run dumps [--check] [--json]'),
      'scripts/unnamed.ts': usage('bun run scripts/unnamed.ts [--check] [--json]'),
    });
    expect((await collectGuards(root)).map((guard) => guard.command)).toEqual([
      'bun run dumps --check',
      'bun run scripts/unnamed.ts --check',
    ]);
  });

  test('a guard that reports by default is listed bare: --write, --check | --write, a required --check', async () => {
    const root = await repo({
      'package.json': '{}',
      'scripts/a.ts': usage('bun run scripts/a.ts [--write] [--json]'),
      'scripts/b.ts': usage('bun run scripts/b.ts [--check | --write] [--json]'),
      'scripts/c.ts': usage('bun run scripts/c.ts --check [--json]   # verify, read-only'),
      'scripts/d.ts': GUARD,
    });
    expect((await collectGuards(root)).map((guard) => guard.command)).toEqual([
      'bun run scripts/a.ts',
      'bun run scripts/b.ts',
      'bun run scripts/c.ts',
      'bun run scripts/d.ts',
    ]);
  });

  test('the real page lists no guard in a form that rewrites the tree', async () => {
    const listed = (await collectGuards(repoRoot())).map((guard) => guard.command);
    expect(listed).toContain('bun run schema-dumps --check');
    expect(listed).not.toContain('bun run schema-dumps');
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
