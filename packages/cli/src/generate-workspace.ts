// `x g app <name>` / `x g package <name>` — one more workspace in the repo — and `--app`, the app
// workspace an app-local generator writes into. Both name a directory under `apps/` or
// `packages/`, and `@<scope>/<name>` is the package either is installed as, so one name is one
// workspace across both kinds.

// why: Bun has no synchronous exists, and every check here runs before a single file is planned.
import { existsSync } from 'node:fs';
// why: Bun ships no path-join primitive.
import { basename, join } from 'node:path';
import { isJsonObject, renderFixShellArg, UltimateError } from '@ultimat3/core';
import { generateSpec } from './cmd-generate-spec';
import type { CommandContext } from './command';
import { invocationOf } from './command';
import { BadFlagError } from './errors';
import { DEFAULT_APP, generate } from './generate-files';
import type { Generator } from './generate-kinds';
import { readName } from './generate-kinds';
import { planWrites, writeFiles } from './generate-write';
import { msg } from './messages';
import type { CommandResult } from './output';
import type { ParsedArgs } from './parse';
import { flagBool } from './parse';
import { quoteArg } from './shell-quote';
import { kebab } from './templates';

/** The two workspace kinds, and the directory each lives under. */
const WORKSPACE_DIR = { app: 'apps', package: 'packages' } as const;

export type WorkspaceKind = keyof typeof WORKSPACE_DIR;

export const isWorkspaceKind = (kind: Generator): kind is WorkspaceKind =>
  kind === 'app' || kind === 'package';

/**
 * Generators whose every write and follow-up edit stays inside the app they land in. The rest
 * register in files only `apps/web` has — the API index, the roles, the exercise file, the db
 * handle — so under another app they would write half a slice there and half here.
 */
const APP_LOCAL: ReadonlySet<Generator> = new Set<Generator>(['route', 'island', 'query']);

/** The next commands after a new workspace: link it, then gate only what changed. */
export const WORKSPACE_NEXT = ['bun install', 'bunx x verify --changed --dirty'] as const;

/** One name, one workspace: `apps/<n>` and `packages/<n>` are both `@<scope>/<n>`. */
export class WorkspaceNameTakenError extends UltimateError {
  constructor(input: {
    readonly kind: WorkspaceKind;
    readonly name: string;
    readonly held: string;
  }) {
    const suffix = input.kind === 'app' ? 'app' : 'shared';
    super({
      code: 'X_WORKSPACE_NAME_TAKEN',
      cause: `${input.held}/ already exists, and apps/${input.name} and packages/${input.name} would both be installed as @<scope>/${input.name} — bun install cannot hold two workspaces under one name`,
      fix: `${input.kind === 'app' ? 'x g app' : 'x g package'} ${renderFixShellArg(`${input.name}-${suffix}`, '<another name>')}`,
      meta: { kind: input.kind, name: input.name, held: input.held },
    });
  }
}

/**
 * The repo's scope: `@acme/root` → `acme`, a bare `acme` → `acme`. A root manifest with no name
 * falls back to the directory's, which is what `x new` named it after.
 */
async function repoScope(root: string): Promise<string> {
  const parsed: unknown = await Bun.file(join(root, 'package.json'))
    .json()
    .catch(() => undefined);
  const name = isJsonObject(parsed) && typeof parsed['name'] === 'string' ? parsed['name'] : '';
  const scope = name.startsWith('@') ? (name.slice(1).split('/')[0] ?? '') : name;
  return kebab(scope === '' ? basename(root) : scope);
}

/** The `x g` flags a workspace generator reads; every other one is a slice's, so is refused. */
const WORKSPACE_READS: ReadonlySet<string> = new Set(['force', 'dry-run']);

/**
 * Any slice flag — `--feature`, `--surface`, `--live`, `--admin`, `--locales`, `--at`, `--app`,
 * `--permission`, … — set to something but its default: a workspace is no slice, so each would be
 * accepted and change nothing. Projected from the spec, so a flag added there is refused here too.
 */
function refuseSliceFlags(args: ParsedArgs, kind: WorkspaceKind, name: string): void {
  for (const flag of generateSpec.flags ?? []) {
    if (WORKSPACE_READS.has(flag.name)) continue;
    const value = args.flags.get(flag.name);
    if (value === undefined || value === flag.default) continue;
    throw new BadFlagError({
      flag: flag.name,
      command: `g ${kind}`,
      reason: `a ${kind} is a workspace, not a slice, so --${flag.name} would change nothing; it reads --force and --dry-run only`,
      fix: `${kind === 'app' ? 'x g app' : 'x g package'} ${renderFixShellArg(name, '<name>')}`,
    });
  }
}

/** `x g app|package <name>`: planned, refused or written, with the two commands that follow. */
export async function runWorkspace(
  ctx: CommandContext,
  root: string,
  kind: WorkspaceKind,
): Promise<CommandResult> {
  const name = kebab(readName(ctx.args.positionals[1], kind));
  refuseSliceFlags(ctx.args, kind, name);
  const other: WorkspaceKind = kind === 'app' ? 'package' : 'app';
  const held = `${WORKSPACE_DIR[other]}/${name}`;
  if (existsSync(join(root, held))) throw new WorkspaceNameTakenError({ kind, name, held });
  const files = generate({ kind, name, scope: await repoScope(root) });
  const force = flagBool(ctx.args, 'force');
  const invocation = [invocationOf(ctx, 'g'), kind, quoteArg(name)].join(' ');
  const dryRun = flagBool(ctx.args, 'dry-run');
  const report = dryRun
    ? await planWrites(root, files, force, invocation, name)
    : await writeFiles(root, files, force, invocation, name);
  const ok = report.conflicts.length === 0;
  const next = ok && !dryRun ? [...WORKSPACE_NEXT] : [];
  const count = report.written.length;
  return {
    ok,
    command: 'g',
    summary: dryRun
      ? msg('cli.generate.planned', { count, kind, name })
      : ok
        ? msg('cli.generate.wroteNext', { count, kind, name, next: next.join(' && ') })
        : msg('cli.generate.wrote', { count, kind, name }),
    data: { files: report.written, ...(dryRun ? { dryRun: true } : {}), ...(ok ? { next } : {}) },
    lines: report.written.map((path) => msg('cli.file.added', { path })),
    findings: report.conflicts,
  };
}

/**
 * `--app`: the app workspace an app-local generator writes into, `web` when absent. Refused when
 * it is no single directory name, when the generator registers in `apps/web` (the run without the
 * flag is the fix), and when `apps/<app>` is not there (`x g app <app>` makes it).
 */
export function readApp(
  raw: string | undefined,
  root: string,
  kind: Generator,
  name: string,
): string {
  if (raw === undefined || raw === DEFAULT_APP) return DEFAULT_APP;
  const without = `x g ${kind} ${quoteArg(name)}`;
  if (!/^[a-z0-9][a-z0-9-]*$/.test(raw)) {
    throw new BadFlagError({
      flag: 'app',
      command: `g ${kind}`,
      reason: `"${raw}" is not an app directory name (a-z, 0-9, -) under apps/`,
      fix: without,
    });
  }
  if (!APP_LOCAL.has(kind)) {
    throw new BadFlagError({
      flag: 'app',
      command: `g ${kind}`,
      reason: `a ${kind} registers in files only apps/${DEFAULT_APP} holds (the API index, the roles, the exercise file, the db handle); --app takes ${[...APP_LOCAL].join(', ')}`,
      fix: without,
    });
  }
  if (!existsSync(join(root, WORKSPACE_DIR.app, raw))) {
    throw new BadFlagError({
      flag: 'app',
      command: `g ${kind}`,
      reason: `apps/${raw}/ does not exist`,
      fix: `x g app ${quoteArg(raw)}`,
    });
  }
  return raw;
}
