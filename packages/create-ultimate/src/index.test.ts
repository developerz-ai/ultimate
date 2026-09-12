import { describe, expect, test } from 'bun:test';
// why: Bun has no mkdtemp, no recursive remove and no existence predicate of its own.
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.file takes one already joined.
import { join } from 'node:path';
import { GLOBAL_FLAGS, newCommand } from '@ultimat3/cli';
import { createApp } from './index';

const capture = async (
  argv: readonly string[],
  cwd: string = process.cwd(),
): Promise<{ code: number; out: string }> => {
  const lines: string[] = [];
  const code = await createApp({
    argv,
    cwd,
    write: (line) => lines.push(line),
  });
  return { code, out: lines.join('\n') };
};

describe('unit · create-ultimate', () => {
  test('delegates to `x new` and plans the monorepo without writing anything', async () => {
    const { code, out } = await capture(['demo-app', '--dry-run', '--json']);
    expect(code).toBe(0);
    const payload = JSON.parse(out) as { ok: boolean; command: string; data: { files: string[] } };
    expect(payload.command).toBe('new');
    expect(payload.data.files).toContain('app.config.ts');
    expect(payload.data.files).toContain('apps/web/site/page.tsx');
  });

  // The fix line is a command the reader is meant to RUN, and this package's whole reason to exist
  // is running before `x` does. `x new myapp` was an instruction nobody in this process could
  // follow: the binary it names is the one they have not installed yet.
  test('a missing name is fixed by the command the caller actually typed', async () => {
    const { code, out } = await capture(['--json']);
    expect(code).toBe(1);
    const payload = JSON.parse(out) as { findings: { code: string; fix: string }[] };
    expect(payload.findings[0]?.code).toBe('X_CLI_BAD_FLAG');
    expect(payload.findings[0]?.fix).toBe('bunx create-ultimate myapp');
  });

  test('a path where a name goes names the same invocation', async () => {
    const { code, out } = await capture(['/srv/apps/shop', '--json']);
    expect(code).toBe(1);
    const payload = JSON.parse(out) as { findings: { code: string; fix: string }[] };
    expect(payload.findings[0]?.fix).toBe('bunx create-ultimate shop --dir /srv/apps');
  });
});

/**
 * The invocation `developerz-ai/developerz.ai` shells out with, token for token
 * (`apps/runner/src/modes/setup/generator.ts`, where `binary` and the argv array are two separate
 * lines). It is the only production caller of this package, and it runs UNATTENDED on a customer's
 * box: nobody reads the output and nothing retries with different flags.
 *
 * Both flags are load-bearing, and until 2026-09-11 no test in this repository typed either one.
 * `--force`, because the target is a clone that already exists — without it `x new` refuses with
 * `X_GENERATE_CONFLICT` and writes nothing. `--no-git`, because that clone is ALREADY a git
 * repository — without it the scaffold is `git init`ed and committed inside the customer's history
 * under the box's identity. A rename of either would be green here and a dead onboarding there,
 * which is why the string is written down rather than derived from anything.
 */
const PLATFORM_INVOCATION = 'bunx create-ultimate <name> --dir <parent> --force --no-git';

/** The pinned string, made runnable — so the pin is the subject and not a decoration beside it. */
const platformArgv = (name: string, parent: string): readonly string[] =>
  PLATFORM_INVOCATION.split(' ')
    .slice(2)
    .map((token) => (token === '<name>' ? name : token === '<parent>' ? parent : token));

describe('unit · create-ultimate · the argv the platform shells out with', () => {
  // Failure case first: the same invocation with `--force` removed is the refusal the flag exists
  // to lift, so a `--force` that silently stopped meaning anything cannot read as a pass below.
  test('without --force the platform target is refused and nothing is written', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'create-ultimate-'));
    try {
      const target = join(parent, 'demo-app');
      await Bun.write(join(target, 'KEEP.txt'), 'the clone that is already there');
      const argv = platformArgv('demo-app', parent).filter((token) => token !== '--force');
      const { code, out } = await capture([...argv, '--json'], parent);
      expect(code).toBe(1);
      const payload = JSON.parse(out) as { findings: { code: string }[] };
      expect(payload.findings[0]?.code).toBe('X_GENERATE_CONFLICT');
      expect(existsSync(join(target, 'app.config.ts'))).toBe(false);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test('the exact argv writes into the existing checkout and inits no repository', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'create-ultimate-'));
    try {
      const target = join(parent, 'demo-app');
      await Bun.write(join(target, 'KEEP.txt'), 'the clone that is already there');
      const { code, out } = await capture([...platformArgv('demo-app', parent), '--json'], parent);
      expect(code).toBe(0);
      const payload = JSON.parse(out) as {
        data: { dir: string; git: { initialized: boolean; committed: boolean } };
      };
      // `--dir <parent>` plus the name IS the checkout, and `--force` wrote into it.
      expect(payload.data.dir).toBe(target);
      expect(existsSync(join(target, 'app.config.ts'))).toBe(true);
      // --force adds; it never clears the directory first, so the clone survives.
      expect(existsSync(join(target, 'KEEP.txt'))).toBe(true);
      // `--no-git`, on disk and in the report: the onboarding landing owns the commit, and a
      // `.git` written here would be a second repository inside the customer's own.
      expect(existsSync(join(target, '.git'))).toBe(false);
      expect(payload.data.git).toMatchObject({ initialized: false, committed: false });
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  }, 60_000);

  // The rename guard. Every `--flag` in the pinned string must be one `x new` still declares, in
  // the spelling a caller types: `git` carries `default: true`, so `--no-git` is the only form of
  // it there is, and a flag that lost its default would stop accepting the negation the platform
  // sends.
  test('every flag in the pinned argv is one `x new` declares, in the spelling it is typed', () => {
    expect(PLATFORM_INVOCATION.startsWith('bunx create-ultimate ')).toBe(true);
    const passed = PLATFORM_INVOCATION.split(' ').filter((token) => token.startsWith('--'));
    expect(passed).toEqual(['--dir', '--force', '--no-git']);
    const declared = newCommand.spec.flags ?? [];
    for (const token of passed) {
      const negated = token.startsWith('--no-');
      const flag = declared.find((entry) => entry.name === token.replace(/^--(no-)?/, ''));
      expect(flag, `${token} is no longer a flag \`x new\` declares`).toBeDefined();
      expect(flag?.default === true, `${token} is spelled for the wrong default`).toBe(negated);
    }
  });
});

/** `--dir`, `--no-example`, … — the first flag token of each row of the README's flag table. */
const readmeFlags = async (): Promise<readonly string[]> =>
  (await Bun.file(join(import.meta.dir, '..', 'README.md')).text())
    .split('\n')
    .flatMap((line) => /^\|\s*`(--[a-z-]+)/.exec(line)?.[1] ?? []);

describe('unit · create-ultimate · the page a maintainer reads', () => {
  // The table listed four flags and `x new` declares five. The two it omitted were `--force` and
  // `--no-git` — precisely the two the only production caller passes — so the page said nothing
  // about the contract this package is under. Derived, so the next flag cannot be omitted either.
  test('the flag table names every flag `x new` declares, in the spelling a caller types', async () => {
    const documented = await readmeFlags();
    const declared = (newCommand.spec.flags ?? []).map((flag) =>
      flag.default === true ? `--no-${flag.name}` : `--${flag.name}`,
    );
    expect(declared).toContain('--force');
    expect(declared).toContain('--no-git');
    for (const flag of declared) {
      expect(documented, `${flag} is undocumented`).toContain(flag);
    }
    // And nothing beyond them but a global every command answers.
    const globals = new Set(GLOBAL_FLAGS.map((flag) => `--${flag.name}`));
    expect(documented.filter((flag) => !declared.includes(flag) && !globals.has(flag))).toEqual([]);
  });

  // `bun install` links `x` into `./node_modules/.bin` and nowhere else, so a bare `x dev` pasted
  // into a fresh shell is `command not found` — the scaffold's own `bin/` wrappers are the form
  // that works, and `bin/setup`'s last line already says `next: bin/dev`. The same rule
  // `scaffold-repo.test.ts` holds over the app's README, held here over the npm page, because this
  // is the first command anybody runs and nothing else was reading it.
  test('the Start block runs only commands a fresh shell has', async () => {
    const lines = (await Bun.file(join(import.meta.dir, '..', 'README.md')).text()).split('\n');
    const open = lines.findIndex((line) => line.startsWith('```sh'));
    const close = lines.findIndex((line, index) => index > open && line.startsWith('```'));
    expect(open).toBeGreaterThan(-1);
    const block = lines.slice(open + 1, close);
    expect(block.length).toBeGreaterThan(0);
    const runnable = /(^|[\s&|;])x\s+[a-z]/;
    expect(block.filter((line) => runnable.test(line) && !line.includes('bunx x'))).toEqual([]);
  });
});
