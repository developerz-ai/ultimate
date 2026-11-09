// `x new --shape`'s two refusals, RUN: each writes nothing, and the fix it prints scaffolds.

import { describe, expect, test } from 'bun:test';
// why: Bun ships no temp-directory API and no recursive delete; `node:fs` owns the throwaway parent.
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { REQUIRED_BUN } from './app-root';
import { newCommand } from './cmd-new';
import type { CommandContext } from './command';
import { NEW_SHAPES } from './new-shapes';
import { parseArgs } from './parse';
import { SPECS } from './registry';
import { SHAPE_OVERLAYS } from './templates/shapes';

const contextFor = (argv: readonly string[], cwd: string) =>
  ({
    args: parseArgs(argv, SPECS),
    cwd,
    runner: async (command) => ({
      command,
      code: 0,
      ok: true,
      stdout: '',
      stderr: '',
      durationMs: 0,
    }),
    env: {},
    bunVersion: REQUIRED_BUN,
  }) satisfies CommandContext;

/** The fix line as argv: the command before a `#` comment, `x` dropped, words split. */
const argvOf = (fix: string): readonly string[] =>
  (fix.split('#')[0] ?? '').trim().split(/\s+/).slice(1);

const refusalOf = async (argv: readonly string[], cwd: string) =>
  newCommand
    .run(contextFor(argv, cwd))
    .then(() => expect.unreachable(`x ${argv.join(' ')} scaffolded`))
    .catch((error: unknown) => error as { code: string; cause: string; fix: string });

const withParent = async (body: (parent: string) => Promise<void>): Promise<void> => {
  const parent = mkdtempSync(join(tmpdir(), 'x-new-shape-'));
  try {
    await body(parent);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
};

describe('unit · x new --shape', () => {
  test('every declared shape has an overlay, and no overlay is undeclared', () => {
    expect(Object.keys(SHAPE_OVERLAYS).sort()).toEqual([...NEW_SHAPES].sort());
  });

  test('x help new lists every shape', () => {
    const spec = SPECS.find((candidate) => candidate.name === 'new');
    const summary = spec?.flags?.find((flag) => flag.name === 'shape')?.summary ?? '';
    for (const shape of NEW_SHAPES) expect(summary).toContain(shape);
  });

  test('an unknown shape is X_NEW_SHAPE_UNKNOWN, writes nothing, and its fix scaffolds', async () => {
    await withParent(async (parent) => {
      const refusal = await refusalOf(['new', 'shop', '--shape', 'store', '--no-git'], parent);
      expect(refusal.code).toBe('X_NEW_SHAPE_UNKNOWN');
      expect(refusal.cause).toContain(NEW_SHAPES.join(', '));
      expect(readdirSync(parent)).toEqual([]);
      await newCommand.run(contextFor([...argvOf(refusal.fix), '--no-git'], parent));
      expect(existsSync(join(parent, 'shop', 'app.config.ts'))).toBe(true);
    });
  });

  test('--shape with --no-example is X_NEW_SHAPE_CONFLICT, and dropping the flag scaffolds', async () => {
    await withParent(async (parent) => {
      const argv = ['new', 'shop', '--shape', 'blog', '--no-example', '--no-git'];
      const refusal = await refusalOf(argv, parent);
      expect(refusal.code).toBe('X_NEW_SHAPE_CONFLICT');
      expect(refusal.fix).toBe('x new shop --shape blog');
      expect(readdirSync(parent)).toEqual([]);
      await newCommand.run(contextFor([...argvOf(refusal.fix), '--no-git'], parent));
      expect(existsSync(join(parent, 'shop', 'apps/web/app/post/entity.ts'))).toBe(true);
    });
  });

  // Sign-in is `x g sign-in`'s: the shape runs it in the app it wrote, before the first commit.
  test('--shape dashboard is born signed in, by the generator, and says so in a dry run', async () => {
    await withParent(async (parent) => {
      const result = await newCommand.run(
        contextFor(['new', 'ops', '--shape', 'dashboard', '--no-git'], parent),
      );
      const files = (result.data as { files: readonly string[] }).files;
      expect(files).toContain('apps/web/app/auth/sign-in/page.tsx');
      expect(files).toContain('apps/web/app/posts/[id]/page.tsx');
      const api = await Bun.file(join(parent, 'ops', 'apps/web/api/index.ts')).text();
      expect(api).toContain('createSession');
      expect(api).toContain('queries: [postList, postById]');
      const dry = await newCommand.run(
        contextFor(['new', 'ops2', '--shape', 'dashboard', '--dry-run'], parent),
      );
      expect((dry.data as { generate: readonly string[] }).generate).toEqual([
        'x g sign-in --password',
      ]);
    });
  });

  test('--dry-run under a shape lists the shape, not the default', async () => {
    await withParent(async (parent) => {
      const result = await newCommand.run(
        contextFor(['new', 'shop', '--shape', 'api', '--dry-run'], parent),
      );
      const files = (result.data as { files: readonly string[] }).files;
      expect(files).toContain('apps/web/app/keys/keys.ts');
      expect(files).not.toContain('apps/web/app/dashboard/page.tsx');
      expect(readdirSync(parent)).toEqual([]);
    });
  });
});
