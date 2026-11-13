// The hook `x new` writes, run the way Claude Code runs it: in an app directory holding the
// scaffold's own `biome.json`, the PostToolUse JSON on stdin and no `$CLAUDE_FILE_PATHS`. It must
// format the edited file, say what biome cannot fix, and pass the app's own lint itself.

import { afterEach, describe, expect, test } from 'bun:test';
// why: a throwaway app directory per test, and a link to this checkout's biome; Bun has neither.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { GeneratedFile } from './naming';
import { names } from './naming';
import { claudeFiles } from './scaffold-claude';
import { HOOK_PATH } from './scaffold-claude-hook';
import { repoFiles } from './scaffold-repo';

const BIOME = `${import.meta.dir}/../../../../node_modules/.bin/biome`;
const app = names('ledger-demo');
const dirs: string[] = [];

const contentsOf = (files: readonly GeneratedFile[], path: string): string =>
  String(files.find((file) => file.path === path)?.contents ?? '');

/** An app root with the scaffold's biome.json, its hook, and `bunx biome` resolvable offline. */
async function appDir(): Promise<string> {
  const root = mkdtempSync(`${tmpdir()}/scaffold-hook-`);
  dirs.push(root);
  mkdirSync(`${root}/node_modules/.bin`, { recursive: true });
  symlinkSync(BIOME, `${root}/node_modules/.bin/biome`);
  const repo = repoFiles(app, '0.0.0', false);
  for (const path of ['biome.json', '.gitignore'])
    await Bun.write(`${root}/${path}`, contentsOf(repo, path));
  Bun.spawnSync(['git', 'init', '-q'], { cwd: root, timeout: 30_000 });
  await Bun.write(`${root}/${HOOK_PATH}`, contentsOf(claudeFiles(app), HOOK_PATH));
  return root;
}

function hook(root: string, file: string): { readonly code: number; readonly stderr: string } {
  const env = { ...Bun.env };
  delete env['CLAUDE_FILE_PATHS'];
  const proc = Bun.spawnSync(['bun', `${root}/${HOOK_PATH}`], {
    cwd: root,
    timeout: 30_000,
    env,
    stdin: new TextEncoder().encode(
      JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: file } }),
    ),
  });
  return { code: proc.exitCode, stderr: proc.stderr.toString() };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('unit · the scaffolded format hook', () => {
  test('formats the file named on stdin, in place', async () => {
    const root = await appDir();
    await Bun.write(`${root}/a.ts`, 'export const a = "x"\n');
    expect(hook(root, `${root}/a.ts`).code).toBe(0);
    expect(await Bun.file(`${root}/a.ts`).text()).toBe("export const a = 'x';\n");
  });

  test('what biome cannot fix is said back, exit 2, with the re-check command', async () => {
    const root = await appDir();
    await Bun.write(`${root}/b.ts`, 'export default function f() {}\n');
    const { code, stderr } = hook(root, `${root}/b.ts`);
    expect(code).toBe(2);
    expect(stderr).toContain('noDefaultExport');
    expect(stderr).toContain(`bunx biome check --write ${root}/b.ts`);
  });

  test("the hook itself is clean under the app's own biome.json", async () => {
    const root = await appDir();
    const proc = Bun.spawnSync([BIOME, 'check', HOOK_PATH], { cwd: root, timeout: 30_000 });
    expect({ code: proc.exitCode, out: proc.stdout.toString() }).toEqual({
      code: 0,
      out: expect.any(String),
    });
  });
});
