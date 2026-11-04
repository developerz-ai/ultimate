// The repo's own build graph, and what it buys: the root tsconfig's JSX keys, the
// `scripts/` project reference, and a real `tsc -b` that fails on a referenced project.
//
// They are here, beside the gate's other tests rather than inside them, because they are one
// responsibility: the tree COMPILES. A rule about a gate is a rule about what the gate does; a
// rule about the build graph is a rule about what the repo is made of.

import { describe, expect, test } from 'bun:test';
// why: Bun has no mkdtemp and no recursive remove.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';
import { exec } from '@ultimat3/cli';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';

const readJson = async (path: string): Promise<unknown> => Bun.file(path).json();

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** One key off a parsed tsconfig, checked rather than cast — the file is data, not a type. */
const field = (value: unknown, key: string): unknown => (isRecord(value) ? value[key] : undefined);

describe("unit · the repo's own build graph", () => {
  // Bun's runtime reads the tsconfig at the CWD to transpile JSX, and at the repo root that is
  // this file — a solution-style config that carries no compilerOptions of its own unless it is
  // told to. Without these two keys every `.tsx` in the repo transpiles against the React
  // automatic runtime, which is not installed, so `bun test` at the root cannot import a single
  // component. One JSX flavour, declared where the runtime looks for it.
  test('the root tsconfig tells the runtime which JSX runtime this repo uses', async () => {
    const options = field(await readJson(join(repoRoot(), 'tsconfig.json')), 'compilerOptions');
    expect(field(options, 'jsx')).toBe('preserve');
    expect(field(options, 'jsxImportSource')).toBe('solid-js');
  });

  /**
   * `tsc -b` compiles the projects the root REFERENCES and nothing else, and a project can only be
   * referenced if it is `composite`. `scripts/` satisfied neither: `scripts/tsconfig.json` set
   * `composite: false` and no `references` entry named it, so `export const probe: number = 'no'`
   * dropped anywhere under `scripts/` left `bunx tsc -b` at exit 0 — the gate's own implementation
   * compiled nowhere, which is how `list-workspaces.ts` shipped passing a string to a number
   * parameter. Both halves are asserted, because either one alone puts the hole straight back.
   */
  test('the root build graph contains scripts/, and scripts/ can be referenced', async () => {
    const root = repoRoot();
    const references = field(await readJson(join(root, 'tsconfig.json')), 'references');
    const paths = (Array.isArray(references) ? references : []).map((ref) => field(ref, 'path'));
    expect(paths).toContain('./scripts');
    const options = field(await readJson(join(root, 'scripts/tsconfig.json')), 'compilerOptions');
    expect(field(options, 'composite')).toBe(true);
  });

  /**
   * What the two keys above BUY, proved against a real `tsc -b` rather than asserted about it: a
   * type error in a referenced composite project fails the build, and the same error in the same
   * project fails nothing once the reference is gone. Run on a two-file solution in a temp dir —
   * the repo's own build is minutes and writes `.tsbuildinfo` every other suite shares.
   */
  test(
    'tsc -b fails on a referenced project and passes over an unreferenced one',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'ultimate-verify-refs-'));
      try {
        const project = {
          compilerOptions: { composite: true, noEmit: true, strict: true, types: [] },
        };
        for (const name of ['sub', 'other']) {
          await Bun.write(join(dir, name, 'tsconfig.json'), JSON.stringify(project));
        }
        await Bun.write(join(dir, 'other/ok.ts'), 'export const ok = 1;\n');
        await Bun.write(
          join(dir, 'sub/probe.ts'),
          "export const probe: number = 'not a number';\n",
        );
        const tsc = join(repoRoot(), 'node_modules/.bin/tsc');
        // `other` is always referenced, so the solution has something to build either way and the
        // exit code is answering "was sub compiled?" and not "was this configuration empty?".
        const build = async (paths: readonly string[]): Promise<number> => {
          const references = paths.map((path) => ({ path }));
          await Bun.write(join(dir, 'tsconfig.json'), JSON.stringify({ files: [], references }));
          await rm(join(dir, 'sub/tsconfig.tsbuildinfo'), { force: true });
          return (await exec([tsc, '-b', '--pretty', 'false'], { cwd: dir })).code;
        };
        expect(await build(['./other', './sub'])).not.toBe(0);
        expect(await build(['./other'])).toBe(0);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    REPO_SCAN_TIMEOUT_MS,
  );
});
