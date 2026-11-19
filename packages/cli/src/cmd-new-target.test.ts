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

/** The refused run's one finding, plus its summary: a refusal is a result, never a throw. */
const refusalOf = async (ctx: CommandContext) => {
  const result = await newCommand.run(ctx);
  expect(result.ok).toBe(false);
  const finding = result.findings?.[0];
  return {
    summary: result.summary,
    code: finding?.code,
    cause: finding?.cause ?? '',
    fix: finding?.fix,
  };
};

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

  // D1: the fix used to be `x new demo-app --force`, and over an existing app that reset its
  // registrations and grants to the template. A fix is pasted with no diff in front of it, so it
  // names a directory that is free, never `--force`.
  test('a directory that already exists is refused with a free name as the fix, and writes nothing', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'x-new-run-'));
    try {
      const target = join(parent, 'demo-app');
      await Bun.write(join(target, 'KEEP.txt'), 'do not overwrite me');
      // `-2` is taken too: the fix names the first name that is not.
      await Bun.write(join(parent, 'demo-app-2', 'KEEP.txt'), 'nor me');
      const refusal = await refusalOf(newContext(['new', 'demo-app'], parent));
      expect(refusal.code).toBe('X_GENERATE_CONFLICT');
      expect(refusal.cause).toContain(`${target} already exists`);
      expect(refusal.cause).toContain('--force');
      expect(refusal.fix).toBe('x new demo-app-3');
      // The summary says what happened, never the generic usage line (D1).
      expect(refusal.summary).toBe(`${target} already exists — nothing was written`);
      expect(refusal.fix).not.toContain('--force');
      // Refused BEFORE writing: nothing but the file the test put there.
      expect(readdirSync(target)).toEqual(['KEEP.txt']);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test('a directory holding an app is refused even with --force, and nothing in it changes', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'x-new-run-'));
    try {
      const target = join(parent, 'demo-app');
      await Bun.write(join(target, 'app.config.ts'), '// the app that is already here\n');
      await Bun.write(join(target, 'apps/web/shared/roles.ts'), '// its grants\n');
      for (const argv of [
        ['new', 'demo-app'],
        ['new', 'demo-app', '--force'],
      ]) {
        const refusal = await refusalOf(newContext(argv, parent));
        expect(refusal.code).toBe('X_GENERATE_CONFLICT');
        expect(refusal.cause).toContain('holds an app');
        expect(refusal.fix).toBe('x new demo-app-2');
        expect(refusal.summary).toBe(
          `${target} already holds an app — x new never scaffolds over one, --force included`,
        );
      }
      expect(await Bun.file(join(target, 'apps/web/shared/roles.ts')).text()).toBe(
        '// its grants\n',
      );
      expect(readdirSync(target).sort()).toEqual(['app.config.ts', 'apps']);
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
      expect(result.summary).toContain(`cd ${join('nested', 'demo-app')} && bun run setup`);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test('the next-steps line enters the resolved target, --dir included, quoted for the shell', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'x-new-run-'));
    try {
      const plain = await newCommand.run(newContext(['new', 'demo-app', '--dry-run'], parent));
      expect(plain.summary).toContain('cd demo-app && bun run setup');
      const spaced = await newCommand.run(
        newContext(['new', 'demo-app', '--dir', 'my apps', '--no-git'], parent),
      );
      expect(spaced.ok).toBe(true);
      expect(spaced.summary).toContain(`cd '${join('my apps', 'demo-app')}' && bun run setup`);
      expect(existsSync(join(parent, 'my apps', 'demo-app', 'package.json'))).toBe(true);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  }, 30_000);
});

// Two scaffolds of one name on one machine shared `<app>-test` and its ports: a stopped stack
// left by the other directory blocked the gate's `live` step. The root picks both now.
describe('unit · x new · the test stack is the checkout’s own', () => {
  const run = (cwd: string) =>
    newCommand.run({
      args: parseArgs(['new', 'bareapp', '--no-example', '--no-git'], SPECS),
      cwd,
      runner: exec,
      env: {},
      bunVersion: REQUIRED_BUN,
    });

  /** The compose project name and the ports the env file points at, in one scaffold. */
  const stackOf = async (dir: string) => ({
    name: /^name: (.+)$/m.exec(
      await Bun.file(join(dir, 'docker/docker-compose.test.yml')).text(),
    )?.[1],
    ports: [
      ...(await Bun.file(join(dir, 'docker/test-services.env')).text()).matchAll(/:(\d{4,5})\b/g),
    ].map((match) => match[1]),
  });

  test('two directories, one name: different project names and different ports', async () => {
    const parents = [0, 1].map(() => mkdtempSync(join(tmpdir(), 'x-new-stack-')));
    try {
      for (const parent of parents) expect((await run(parent)).ok).toBe(true);
      const [a, b] = await Promise.all(parents.map((parent) => stackOf(join(parent, 'bareapp'))));
      expect(a?.name).toStartWith('bareapp-test-');
      expect(b?.name).toStartWith('bareapp-test-');
      expect(a?.name).not.toBe(b?.name);
      expect(a?.ports.length).toBeGreaterThan(0);
      expect(a?.ports).not.toEqual(b?.ports);
    } finally {
      for (const parent of parents) rmSync(parent, { recursive: true, force: true });
    }
  }, 60_000);

  test('a plan with no root is the bytes it always was: the codemods compare against them', () => {
    const compose = planNewApp({ name: 'bareapp', example: false }).find(
      (file) => file.path === 'docker/docker-compose.test.yml',
    );
    expect(String(compose?.contents)).toContain('\nname: bareapp-test\n');
  });
});
