// `x new <name>` — a monorepo that already runs: auth, a seeded database, a 0kb landing page, a
// streaming dashboard, an admin app with MCP on, and an example feature slice with passing tests.
// Interactive-free: every choice is a flag with a default, because an agent cannot answer prompts.

import { existsSync } from 'node:fs';
import { chmod } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { dedupe } from './cmd-generate';
import type { CliCommand, CommandContext } from './command';
import { writeSchemaHash } from './drift';
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
  readonly schemaHash: string;
}

export async function writeNewApp(target: string, options: NewAppOptions): Promise<WrittenApp> {
  const files = planNewApp(options);
  for (const file of files) await Bun.write(join(target, file.path), file.contents);
  for (const path of EXECUTABLE_FILES) await chmod(join(target, path), 0o755);
  // Record the schema hash beside the initial migration so `x verify` sees no drift on run one.
  const hash = await writeSchemaHash(target, '0000_initial');
  return { dir: target, files: files.map((file) => file.path), schemaHash: hash };
}

function parentDir(cwd: string, dirFlag: string | undefined): string {
  if (dirFlag === undefined) return cwd;
  return isAbsolute(dirFlag) ? dirFlag : join(cwd, dirFlag);
}

export const newCommand: CliCommand = {
  spec: {
    name: 'new',
    summary: 'scaffold a new Ultimate monorepo that already runs',
    usage: 'x new <name> [--dir path] [--no-example] [--dry-run] [--json]',
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
    if (raw === undefined) {
      return {
        ok: false,
        command: 'new',
        summary: msg('cli.usage'),
        findings: [
          {
            code: 'X_CLI_BAD_FLAG',
            cause: 'x new needs a name',
            fix: 'x new myapp',
            docs: 'https://ultimate.dev/errors/X_CLI_BAD_FLAG',
          },
        ],
      };
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
      data: { dir: written.dir, files: written.files, schemaHash: written.schemaHash },
      lines: [`  ${written.files.length} files in ${target}`],
    };
  },
};
