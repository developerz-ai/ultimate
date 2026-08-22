// `x new <name>` — a monorepo that already runs: auth, a seeded database, a 0kb landing page, a
// streaming dashboard, an admin app with MCP on, and an example feature slice with passing tests.
// Interactive-free: every choice is a flag with a default, because an agent cannot answer prompts.

import { existsSync } from 'node:fs';
import { chmod } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { renderThrowable } from '@ultimat3/core';
import { dedupe } from './cmd-generate';
import type { CliCommand, CommandContext } from './command';
import { MissingPositionalError } from './errors';
import type { Runner } from './exec';
import { msg } from './messages';
import type { CommandResult } from './output';
import { flagBool, flagString } from './parse';
import type { GeneratedFile } from './templates';
import { appFiles, EXECUTABLE_FILES, names, repoFiles, resourceFiles } from './templates';
import { loadVersion } from './version-loader';

export interface NewAppOptions {
  readonly name: string;
  /** The example feature slice. `--no-example` gives the same shape with an empty app/. */
  readonly example: boolean;
}

/** `--no-git`'s `problem`, matched rather than re-spelled where the report decides on a line. */
export const SKIPPED = 'skipped by --no-git';

/**
 * What `git init && git add -A && git commit` did, reported on `data.git` either way.
 *
 * A type alias and not an `interface`, because it IS `CommandResult.data`: an interface has no
 * implicit index signature, so it is not assignable to `JsonValue` and the `--json` contract would
 * not compile (TS2322).
 */
export type RepositoryInit = {
  readonly initialized: boolean;
  readonly committed: boolean;
  /**
   * Why not — `null` when both halves ran. Required rather than optional, so `data.git` has one
   * shape for a machine reading `--json`: a key that appears only on failure is a key every
   * consumer has to guess at. Never a raw thrown value; `renderThrowable` writes it.
   */
  readonly problem: string | null;
};

/**
 * Plain `git init`, with no `--initial-branch`: that flag is git 2.28+, and a scaffold that failed
 * on an older git would trade a working tree for a branch name. The repository takes whatever
 * `init.defaultBranch` this machine already agreed on.
 */
const GIT_STEPS: readonly (readonly string[])[] = [
  ['git', 'init'],
  ['git', 'add', '-A'],
  ['git', 'commit', '-m', 'x new'],
];

/** What `--no-git` records, so `data.git` has the same shape whichever way the flag went. */
const NO_GIT: RepositoryInit = { initialized: false, committed: false, problem: SKIPPED };

/**
 * A scaffold is a REPOSITORY, because three surfaces of this CLI already assume one and answered
 * `not a git repository` in a fresh app: `x affected`, `x ci` and `x pr`. It was four —
 * `X_ROUTE_FILE_INVALID`'s `fix:` was a `git mv` that exits 128 with no `.git` to run in, and that
 * one is now a plain `mv -n` (`packages/render/src/registry.ts`) rather than a reason to init.
 *
 * It never fails `x new`. The command's job is the tree, that tree is on disk by the time this
 * runs, and a box with no `git` or no configured `user.email` would otherwise get an app it cannot
 * see — so the outcome is DATA, and a failure is one line naming the commands to run by hand.
 */
export async function initRepository(runner: Runner, dir: string): Promise<RepositoryInit> {
  let initialized = false;
  for (const command of GIT_STEPS) {
    try {
      const result = await runner(command, { cwd: dir });
      if (!result.ok) {
        const detail = (result.stderr.trim() || result.stdout.trim()).split('\n')[0] ?? '';
        return { initialized, committed: false, problem: `${command.join(' ')}: ${detail}` };
      }
    } catch (error) {
      // The thrown value is genuinely unknown — `exec` refuses a missing program by throwing —
      // and core's renderer is the one spelling that cannot itself throw on a hostile `toString`.
      return { initialized, committed: false, problem: renderThrowable(error) };
    }
    initialized = true;
  }
  return { initialized: true, committed: true, problem: null };
}

/** Pure: the complete file list for a new app, so `--dry-run` and the test see the same thing. */
export function planNewApp(options: NewAppOptions): readonly GeneratedFile[] {
  const app = names(options.name);
  const files: GeneratedFile[] = [
    ...repoFiles(app, loadVersion(), options.example),
    ...appFiles(app, options.example),
  ];
  if (options.example) {
    files.push(...resourceFiles('post', { surfaceDir: 'apps/web/app', feature: 'post' }));
  }
  // `repoFiles`' own catalog entry and the example resource's both target the same flat catalog
  // file, so this has to be the merge-aware dedupe — the one `cmd-generate.ts` uses for `x g` —
  // or the second contributor's keys would silently vanish instead of landing in the one file.
  return dedupe(files);
}

export interface WrittenApp {
  readonly dir: string;
  readonly files: readonly string[];
}

/**
 * Every byte it writes is in `planNewApp`, so `--dry-run` and the disk cannot disagree.
 *
 * It writes NO migration and no `.hash`: `x db gen` is the one writer of `packages/db/migrations`,
 * and it writes `.sql`, `.snapshot.json` and `.hash` together. A scaffold that wrote a `.hash` for
 * a migration whose snapshot never existed is what made the app's first two database commands
 * refuse each other — `x db migrate` naming `x db gen`, and `x db gen` refusing a sidecar version
 * control never had. The consequence is deliberate: `x verify`'s `drift` step is red on a pristine
 * scaffold until `x db gen "initial"` runs, which is what `cli.new.done` tells the author to do.
 */
export async function writeNewApp(target: string, options: NewAppOptions): Promise<WrittenApp> {
  const files = planNewApp(options);
  for (const file of files) await Bun.write(join(target, file.path), file.contents);
  for (const path of EXECUTABLE_FILES) await chmod(join(target, path), 0o755);
  return { dir: target, files: files.map((file) => file.path) };
}

function parentDir(cwd: string, dirFlag: string | undefined): string {
  if (dirFlag === undefined) return cwd;
  return isAbsolute(dirFlag) ? dirFlag : join(cwd, dirFlag);
}

export const newCommand: CliCommand = {
  spec: {
    name: 'new',
    summary: 'scaffold a new Ultimate monorepo that already runs',
    // Every flag the table below declares, in the spelling that turns it off where the default is
    // on: the usage line offered `--no-example` while the table listed `--example`, and a reader
    // had to reconcile the two to answer "which one do I get if I type neither".
    usage: 'x new <name> [--dir path] [--no-example] [--no-git] [--dry-run] [--force] [--json]',
    flags: [
      { name: 'dir', type: 'string', summary: 'parent directory (default: cwd)' },
      {
        // The summary carries the default and the negation because the page has to answer "which
        // one do I get if I type neither": the usage line offered `--no-example`, this table said
        // `--example`, and `default: true` is a field only `--json` renders. 134 files against 107.
        name: 'example',
        type: 'boolean',
        summary: 'include the example feature slice (default: on; --no-example for an empty app/)',
        default: true,
      },
      {
        name: 'git',
        type: 'boolean',
        summary: 'git init and commit the scaffold (default: on; --no-git for a bare directory)',
        default: true,
      },
      { name: 'dry-run', type: 'boolean', summary: 'print the file list, write nothing' },
      { name: 'force', type: 'boolean', summary: 'write into a directory that already exists' },
    ],
  },
  async run(ctx: CommandContext): Promise<CommandResult> {
    const raw = ctx.args.positionals[0];
    // The class, not a hand-built finding with the same code: `MissingPositionalError` is what
    // names the missing POSITIONAL, and a finding assembled here is a second, unenforced copy of
    // a cause the class already writes — one that said "x new needs a name" and not what a name is.
    if (raw === undefined) {
      throw new MissingPositionalError({
        command: 'new',
        positional: 'name',
        example: 'x new myapp',
      });
    }
    const app = names(raw);
    const target = resolve(parentDir(ctx.cwd, flagString(ctx.args, 'dir')), app.kebab);
    const options: NewAppOptions = { name: raw, example: ctx.args.flags.get('example') !== false };

    if (flagBool(ctx.args, 'dry-run')) {
      const files = planNewApp(options);
      return {
        ok: true,
        command: 'new',
        summary: msg('cli.new.done', { name: app.kebab }),
        data: { dir: target, files: files.map((file) => file.path), dryRun: true },
        lines: files.map((file) => msg('cli.file.added', { path: `${app.kebab}/${file.path}` })),
      };
    }
    if (existsSync(target) && !flagBool(ctx.args, 'force')) {
      return {
        ok: false,
        command: 'new',
        summary: msg('cli.usage'),
        findings: [
          {
            code: 'X_GENERATE_CONFLICT',
            cause: `${target} already exists`,
            fix: `x new ${app.kebab} --force, or choose another name`,
            docs: 'https://ultimate.dev/errors/X_GENERATE_CONFLICT',
            at: target,
          },
        ],
      };
    }
    const written = await writeNewApp(target, options);
    const git =
      ctx.args.flags.get('git') === false ? NO_GIT : await initRepository(ctx.runner, target);
    const lines = [msg('cli.new.wrote', { count: written.files.length, dir: target })];
    if (git.problem !== null && git.problem !== SKIPPED) {
      lines.push(msg('cli.new.noRepository', { problem: git.problem }));
      // Raw, unlike the two prose lines around it: this one is an instruction to run verbatim, and
      // a translated command is a broken one (`packages/cli/CLAUDE.md`).
      lines.push(`  run: cd ${target} && git init && git add -A && git commit -m 'x new'`);
    }
    return {
      ok: true,
      command: 'new',
      summary: msg('cli.new.done', { name: app.kebab }),
      data: { dir: written.dir, files: written.files, git },
      lines,
    };
  },
};
