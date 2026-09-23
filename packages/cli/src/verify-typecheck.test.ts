// #450, reproduced with the real compiler: a dependency replaced in place with an OLD mtime — what
// a Bun hardlinked install of an already-cached version does — is skipped by `tsc -b` and caught
// by the invocation `typecheckArgs` chooses for a root with no references.

import { describe, expect, test } from 'bun:test';
// why: Bun ships no `Bun.*` equivalent for either — `mkdtemp`/`rm` own the throwaway root, and
// `utimes` is the only way to hand a file the old mtime a hardlinked install carries.
import { mkdtemp, rm, utimes } from 'node:fs/promises';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { typecheckArgs, usesProjectReferences } from './verify-typecheck';

const TSC = join(import.meta.dir, '../../../node_modules/.bin/tsc');
const OLD = new Date('2020-01-01T00:00:00Z');

const tsc = (root: string, argv: readonly string[]): number =>
  Bun.spawnSync([TSC, ...argv.slice(1)], { cwd: root, stdout: 'pipe', stderr: 'pipe' }).exitCode;

async function writeDep(root: string, type: 'number' | 'string'): Promise<void> {
  const path = join(root, 'node_modules/dep/index.d.ts');
  await Bun.write(path, `export declare const x: ${type};\n`);
  await utimes(path, OLD, OLD);
}

describe('unit · the typecheck step cannot be fooled by an old mtime (#450)', () => {
  test('a root with references keeps -b; a root without them is -p .', async () => {
    const root = await mkdtemp(join(tmpdir(), 'x-typecheck-mode-'));
    try {
      expect(await usesProjectReferences(root)).toBe(false);
      expect(await typecheckArgs(root, 'tsc')).toEqual(['tsc', '-p', '.', '--pretty', 'false']);
      await Bun.write(join(root, 'tsconfig.json'), '{ "include": ["src"] }');
      expect(await usesProjectReferences(root)).toBe(false);
      await Bun.write(join(root, 'tsconfig.json'), '// solution\n{ "references": [] }');
      expect(await typecheckArgs(root, 'tsc')).toEqual(['tsc', '-b', '--pretty', 'false']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('a back-dated dependency change is red under the chosen invocation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'x-typecheck-450-'));
    try {
      await Bun.write(
        join(root, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            module: 'ESNext',
            moduleResolution: 'bundler',
            strict: true,
            noEmit: true,
            incremental: true,
            types: [],
          },
          include: ['src'],
        }),
      );
      await Bun.write(
        join(root, 'node_modules/dep/package.json'),
        '{"name":"dep","types":"index.d.ts"}',
      );
      await Bun.write(
        join(root, 'src/a.ts'),
        "import { x } from 'dep';\nexport const y: number = x;\n",
      );
      await writeDep(root, 'number');
      const argv = await typecheckArgs(root, 'tsc');
      expect(tsc(root, argv)).toBe(0);

      await writeDep(root, 'string');
      // The defect, pinned so the day tsc stops trusting dates this test says so: `-b` is green.
      expect(tsc(root, ['tsc', '-b', '--pretty', 'false'])).toBe(0);
      expect(tsc(root, argv)).not.toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});
