// `x new`'s target directory: where the app lands (`<parent>/<kebab-name>`, `--dir`), what an
// existing directory costs (`--force`), and what `--dry-run` promises without writing. Split from
// `cmd-new.test.ts`, whose subject is what the scaffold contains rather than where it goes.

import { describe, expect, test } from 'bun:test';
// why: Bun has no temp-directory API and no recursive remove.
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';
import { REQUIRED_BUN } from './app-root';
import { newCommand, planNewApp } from './cmd-new';
import type { CommandContext } from './command';
import { exec } from './exec';
import { parseArgs } from './parse';
import { SPECS } from './registry';

describe('unit · x new · writing into the parent directory', () => {
  const newContext = (argv: readonly string[], cwd: string): CommandContext => ({
    args: parseArgs(argv, SPECS),
    cwd,
    runner: exec,
    env: {},
    bunVersion: REQUIRED_BUN,
  });

  // `--no-git`, so the report is the count line and nothing else on every box. The default path
  // appends `no repository — …` wherever `git commit` cannot run, and a CI runner configures no
  // `user.email` — so an exact-lines assertion against the default is a test that reads the
  // machine's git config, not the command. The repository is `cmd-new-git.test.ts`'s subject.
  test('the app lands under <parent>/<kebab-name>, and the report counts what it wrote', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'x-new-run-'));
    try {
      // A name that is NOT already kebab: the directory is the kebab form, never the argument.
      const written = await newCommand.run(newContext(['new', 'Demo App', '--no-git'], parent));
      expect(written.ok).toBe(true);
      const target = join(parent, 'demo-app');
      const data = written.data as { dir: string; files: readonly string[] };
      expect(data.dir).toBe(target);
      expect(existsSync(join(target, 'app.config.ts'))).toBe(true);
      // Every planned file is on disk, and the plan is what the report names.
      expect(data.files).toEqual(
        planNewApp({ name: 'Demo App', example: true }).map((f) => f.path),
      );
      expect(written.lines).toEqual([`  ${data.files.length} files in ${target}`]);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  }, 30_000);

  test('a directory that already exists is refused with --force as the fix, and writes nothing', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'x-new-run-'));
    try {
      const target = join(parent, 'demo-app');
      await Bun.write(join(target, 'KEEP.txt'), 'do not overwrite me');
      const result = await newCommand.run(newContext(['new', 'demo-app'], parent));
      expect(result.ok).toBe(false);
      const finding = result.findings?.[0];
      expect(finding?.code).toBe('X_GENERATE_CONFLICT');
      expect(finding?.cause).toBe(`${target} already exists`);
      expect(finding?.fix).toBe('x new demo-app --force   # or choose another name');
      expect(finding?.at).toBe(target);
      // Refused BEFORE writing: nothing but the file the test put there.
      expect(readdirSync(target)).toEqual(['KEEP.txt']);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test('--force writes into the directory that was refused', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'x-new-run-'));
    try {
      const target = join(parent, 'demo-app');
      await Bun.write(join(target, 'KEEP.txt'), 'kept');
      const result = await newCommand.run(newContext(['new', 'demo-app', '--force'], parent));
      expect(result.ok).toBe(true);
      expect(existsSync(join(target, 'app.config.ts'))).toBe(true);
      // --force adds; it does not clear the directory first.
      expect(existsSync(join(target, 'KEEP.txt'))).toBe(true);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  }, 30_000);

  test('--dir is resolved against the cwd when it is relative, and taken whole when absolute', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'x-new-run-'));
    try {
      const relative = await newCommand.run(
        newContext(['new', 'demo-app', '--dir', 'nested', '--dry-run'], parent),
      );
      expect((relative.data as { dir: string }).dir).toBe(join(parent, 'nested', 'demo-app'));
      const absolute = await newCommand.run(
        newContext(['new', 'demo-app', '--dir', parent, '--dry-run'], tmpdir()),
      );
      expect((absolute.data as { dir: string }).dir).toBe(join(parent, 'demo-app'));
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  // K13: a dry run that says "created" is a report an agent branches on wrongly — and the paths
  // it listed were `demo-app/…` even when `--dir` put the app somewhere else.
  test('--dry-run says it WOULD create, lists the real target paths and writes nothing', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'x-new-run-'));
    try {
      const result = await newCommand.run(
        newContext(['new', 'demo-app', '--dir', 'nested', '--dry-run'], parent),
      );
      expect(result.ok).toBe(true);
      expect(result.summary).toContain('would create demo-app');
      expect(result.summary).not.toMatch(/^created/);
      expect(result.summary).toContain(join(parent, 'nested', 'demo-app'));
      const lines = result.lines ?? [];
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) expect(line).toContain(join('nested', 'demo-app', ''));
      expect(existsSync(join(parent, 'nested'))).toBe(false);
      // The follow-up is a command pasted in the caller's cwd: it enters where the app WOULD land.
      expect(result.summary).toContain(`cd ${join('nested', 'demo-app')} && bin/setup`);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test('the next-steps line enters the resolved target, --dir included, quoted for the shell', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'x-new-run-'));
    try {
      const plain = await newCommand.run(newContext(['new', 'demo-app', '--dry-run'], parent));
      expect(plain.summary).toContain('cd demo-app && bin/setup');
      const spaced = await newCommand.run(
        newContext(['new', 'demo-app', '--dir', 'my apps', '--no-git'], parent),
      );
      expect(spaced.ok).toBe(true);
      expect(spaced.summary).toContain(`cd '${join('my apps', 'demo-app')}' && bin/setup`);
      expect(existsSync(join(parent, 'my apps', 'demo-app', 'package.json'))).toBe(true);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  }, 30_000);
});
