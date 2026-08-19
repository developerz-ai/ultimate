// `x new <name>` — a monorepo that already runs: auth, a seeded database, a 0kb landing page, a
// streaming dashboard, an admin app with MCP on, and an example feature slice with passing tests.
// Interactive-free: every choice is a flag with a default, because an agent cannot answer prompts.

import { existsSync } from 'node:fs';
import { chmod } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { dedupe } from './cmd-generate';
import type { CliCommand, CommandContext } from './command';
import { MissingPositionalError } from './errors';
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

/** Pure: the complete file list for a new app, so `--dry-run` and the test see the same thing. */
export function planNewApp(options: NewAppOptions): readonly GeneratedFile[] {
  const app = names(options.name);
  const files: GeneratedFile[] = [
    ...repoFiles(app, loadVersion(), options.example),
    ...appFiles(app),
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
    usage: 'x new <name> [--dir path] [--no-example] [--dry-run] [--force] [--json]',
    flags: [
      { name: 'dir', type: 'string', summary: 'parent directory (default: cwd)' },
      {
        name: 'example',
        type: 'boolean',
        summary: 'include the example feature slice',
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
    return {
      ok: true,
      command: 'new',
      summary: msg('cli.new.done', { name: app.kebab }),
      data: { dir: written.dir, files: written.files },
      lines: [`  ${written.files.length} files in ${target}`],
    };
  },
};
