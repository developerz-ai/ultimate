// Feeds after-edit.ts the PostToolUse JSON Claude Code sends — the edited path on stdin as
// `tool_input.file_path`, no `$CLAUDE_FILE_PATHS` — and reads what it did to the file and said.

import { afterEach, describe, expect, test } from 'bun:test';
// why: a throwaway repository per test; Bun ships no mkdtemp.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { checksFor } from './after-edit';

const HOOK = `${import.meta.dir}/after-edit.ts`;
const roots: string[] = [];

/** A repository root (a `.git` dir and a biome config with its formatter defaults). */
function repo(): string {
  const root = mkdtempSync(`${tmpdir()}/after-edit-`);
  roots.push(root);
  mkdirSync(`${root}/.git`);
  return root;
}

async function run(record: unknown): Promise<{ readonly code: number; readonly stderr: string }> {
  const env = { ...Bun.env };
  delete env['CLAUDE_FILE_PATHS'];
  const proc = Bun.spawnSync(['bun', HOOK], {
    stdin: new TextEncoder().encode(JSON.stringify(record)),
    env,
  });
  return { code: proc.exitCode, stderr: proc.stderr.toString() };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('after-edit formats the file named on stdin', () => {
  test('an Edit record: the file is rewritten in place, exit 0', async () => {
    const root = repo();
    await Bun.write(`${root}/biome.json`, '{}\n');
    await Bun.write(`${root}/a.ts`, 'const a = 1\nexport { a }\n');
    const { code } = await run({ tool_name: 'Edit', tool_input: { file_path: `${root}/a.ts` } });
    expect(code).toBe(0);
    expect(await Bun.file(`${root}/a.ts`).text()).toBe('const a = 1;\n\nexport { a };\n');
  });

  test('an unfixable lint error is said back with the one command that re-checks it', async () => {
    const root = repo();
    await Bun.write(
      `${root}/biome.json`,
      '{"linter":{"rules":{"suspicious":{"noDebugger":"error"}}}}\n',
    );
    await Bun.write(`${root}/b.ts`, 'export function f() {\n  debugger;\n}\n');
    const { code, stderr } = await run({
      tool_name: 'Write',
      tool_input: { file_path: `${root}/b.ts` },
    });
    expect(code).toBe(2);
    expect(stderr).toContain('noDebugger');
    expect(stderr).toContain(`bunx biome check --write ${root}/b.ts`);
  });

  test('no path on stdin, or a path in no repository: nothing runs, exit 0', async () => {
    expect((await run({ tool_name: 'Edit', tool_input: {} })).code).toBe(0);
    const loose = mkdtempSync(`${tmpdir()}/after-edit-loose-`);
    roots.push(loose);
    await Bun.write(`${loose}/c.ts`, 'const c = 1\n');
    expect((await run({ tool_input: { file_path: `${loose}/c.ts` } })).code).toBe(0);
    expect(await Bun.file(`${loose}/c.ts`).text()).toBe('const c = 1\n');
  });
});

describe('which narrow checks an edit selects', () => {
  test('a package source file adds boundaries; anything else formats only', () => {
    expect(checksFor('packages/core/src/errors.ts')).toEqual(['format', 'boundaries']);
    expect(checksFor('packages/ui/src/button.tsx')).toEqual(['format', 'boundaries']);
    expect(checksFor('packages/core/package.json')).toEqual(['format', 'boundaries']);
    expect(checksFor('docs/idea/02-primitives.md')).toEqual(['format']);
    expect(checksFor('scripts/verify.ts')).toEqual(['format']);
  });
});
