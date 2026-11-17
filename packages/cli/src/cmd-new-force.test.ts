// `x new --force` into a directory that already exists: it writes only into paths that are free.
// One planned path already on disk refuses the run before a byte is written — `--force` used to
// overwrite a monorepo root's `package.json` and `README.md` with the template (round 3, P1).

import { describe, expect, test } from 'bun:test';
// why: Bun has no temp-directory API, no mkdir and no recursive remove.
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.file takes one already joined.
import { join } from 'node:path';
import { REQUIRED_BUN } from './app-root';
import { newCommand } from './cmd-new';
import { targetConflict } from './cmd-new-target';
import type { CommandContext } from './command';
import { exec } from './exec';
import { parseArgs } from './parse';
import { SPECS } from './registry';

const newContext = (argv: readonly string[], cwd: string): CommandContext => ({
  args: parseArgs(argv, SPECS),
  cwd,
  runner: exec,
  env: {},
  bunVersion: REQUIRED_BUN,
});

/** A parent directory with `probe/` already in it, removed whatever the test's verdict. */
const withTarget = async (body: (parent: string, target: string) => Promise<void>) => {
  const parent = mkdtempSync(join(tmpdir(), 'x-new-force-'));
  try {
    const target = join(parent, 'probe');
    mkdirSync(target);
    await body(parent, target);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
};

describe('unit · x new --force · only into free paths', () => {
  // The auditor's repro, verbatim: a monorepo root's own files were replaced with `ok: true`.
  test('a planned path already on disk refuses the run, names it, and nothing changes', async () => {
    await withTarget(async (parent, target) => {
      await Bun.write(join(target, 'package.json'), '{"name":"ggrts-root"}');
      await Bun.write(join(target, 'README.md'), '# mine');
      const result = await newCommand.run(
        newContext(['new', 'probe', '--dir', parent, '--force', '--no-git', '--json'], parent),
      );
      expect(result.ok).toBe(false);
      expect(result.summary).toBe(
        `${target} already holds 2 of the files x new writes — nothing was written, --force included`,
      );
      const finding = result.findings?.[0];
      expect(finding?.code).toBe('X_GENERATE_CONFLICT');
      expect(finding?.cause).toContain('README.md, package.json');
      // A free directory, never `--force` again: the same run would be refused the same way.
      expect(finding?.cause).toContain('mv -n README.md README.md.orig');
      expect(finding?.fix).toBe(`x new probe-2 --dir ${parent} --no-git`);
      expect(readdirSync(target).sort()).toEqual(['README.md', 'package.json']);
      expect(await Bun.file(join(target, 'package.json')).text()).toBe('{"name":"ggrts-root"}');
      expect(await Bun.file(join(target, 'README.md')).text()).toBe('# mine');
    });
  });

  test('a fresh clone holding only .git and a LICENSE still scaffolds with --force', async () => {
    await withTarget(async (parent, target) => {
      await Bun.write(join(target, '.git', 'HEAD'), 'ref: refs/heads/main\n');
      await Bun.write(join(target, 'LICENSE'), 'MIT');
      const result = await newCommand.run(newContext(['new', 'probe', '--force'], parent));
      expect(result.ok).toBe(true);
      expect(await Bun.file(join(target, 'app.config.ts')).exists()).toBe(true);
      expect(await Bun.file(join(target, 'LICENSE')).text()).toBe('MIT');
    });
  }, 30_000);

  test('an empty directory still scaffolds with --force', async () => {
    await withTarget(async (parent, target) => {
      const result = await newCommand.run(
        newContext(['new', 'probe', '--force', '--no-git'], parent),
      );
      expect(result.ok).toBe(true);
      expect(await Bun.file(join(target, 'package.json')).exists()).toBe(true);
    });
  }, 30_000);

  test('a FILE where the plan needs a directory is a collision too', async () => {
    await withTarget(async (_parent, target) => {
      await Bun.write(join(target, 'apps'), 'a file, not a directory');
      const refusal = targetConflict({
        target,
        slug: 'probe',
        force: true,
        invocation: 'x new',
        flags: ['--force'],
        planned: ['apps/web/app.ts', 'README.md'],
      });
      expect(refusal?.findings?.[0]?.cause).toContain(': apps.');
    });
  });

  test('the cause lists the first five colliding paths and counts the rest', async () => {
    await withTarget(async (_parent, target) => {
      const planned = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'untouched'];
      for (const path of planned.slice(0, 7)) await Bun.write(join(target, path), 'mine');
      const refusal = targetConflict({
        target,
        slug: 'probe',
        force: true,
        invocation: 'bunx create-ultimate',
        flags: ['--force'],
        planned,
      });
      const cause = refusal?.findings?.[0]?.cause ?? '';
      expect(cause).toContain(': a, b, c, d, e and 2 more.');
      expect(cause).not.toContain('untouched');
      expect(refusal?.findings?.[0]?.fix).toBe('bunx create-ultimate probe-2');
    });
  });
});
