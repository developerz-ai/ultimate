// `x g <primitive> <name>` — scaffolding with tests that pass on the first run. A generator that
// emits a TODO has moved the work, not done it; every file this writes typechecks, and every
// primitive arrives with the test that pins its distant invariants (policy, idempotency, budget).

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { requireAppRoot } from './app-root';
import type { CliCommand, CommandContext } from './command';
import { CliNotImplementedError, UnknownCommandError } from './errors';
import { msg } from './messages';
import type { CommandResult, Finding } from './output';
import { flagBool, flagString } from './parse';
import type { GeneratedFile, Surface } from './templates';
import {
  actionFiles,
  entityFiles,
  jobFiles,
  policyFiles,
  queryFiles,
  resourceFiles,
  routeFiles,
  taskFiles,
} from './templates';

export const GENERATORS = [
  'resource',
  'action',
  'mutator',
  'job',
  'route',
  'policy',
  'entity',
  'query',
  'task',
] as const;

export type Generator = (typeof GENERATORS)[number];

export interface GenerateOptions {
  readonly kind: Generator;
  readonly name: string;
  readonly feature?: string;
  readonly surface?: Surface;
  readonly live?: boolean;
}

const DEFAULT_SURFACE_DIR: Record<Surface, string> = {
  site: 'apps/web/site',
  app: 'apps/web/app',
};

/** Two generators can legitimately produce the same shared file (errors.ts); first write wins. */
function dedupe(files: readonly GeneratedFile[]): readonly GeneratedFile[] {
  const seen = new Map<string, GeneratedFile>();
  for (const file of files) if (!seen.has(file.path)) seen.set(file.path, file);
  return [...seen.values()];
}

/**
 * Pure: returns the files a generator would write. `x g` writes them, the generator test asserts
 * on them, and nothing has to run a filesystem to review what a generator produces.
 */
export function generate(options: GenerateOptions): readonly GeneratedFile[] {
  const surface: Surface = options.surface ?? 'app';
  const surfaceDir = DEFAULT_SURFACE_DIR[surface];
  const feature = options.feature ?? options.name;
  const target = { surfaceDir, feature };
  switch (options.kind) {
    case 'resource':
      return dedupe(resourceFiles(options.name, target));
    case 'action':
      return dedupe(actionFiles(options.name, target));
    case 'mutator':
      return dedupe(actionFiles(options.name, { ...target, mutator: true }));
    case 'entity':
      return dedupe(entityFiles(options.name, target));
    case 'policy':
      return dedupe(policyFiles(options.name, target));
    case 'query':
      return dedupe(queryFiles(options.name, { ...target, live: options.live === true }));
    case 'job':
      return dedupe(jobFiles(options.name, target));
    case 'task':
      return dedupe(taskFiles(options.name, target));
    case 'route':
      return dedupe(routeFiles(options.name, { surface }));
    default:
      throw new CliNotImplementedError({
        feature: `generator "${String(options.kind)}"`,
        fix: `x g ${GENERATORS.join('|')}`,
      });
  }
}

export interface WriteReport {
  readonly written: readonly string[];
  readonly conflicts: readonly Finding[];
}

/** Never clobbers. A generator that overwrites is a generator nobody runs twice. */
export async function writeFiles(
  root: string,
  files: readonly GeneratedFile[],
  force: boolean,
): Promise<WriteReport> {
  const written: string[] = [];
  const conflicts: Finding[] = [];
  for (const file of files) {
    const absolute = join(root, file.path);
    if (!force && existsSync(absolute)) {
      conflicts.push({
        code: 'X_GENERATE_CONFLICT',
        cause: `${file.path} already exists`,
        fix: `x g --force to overwrite, or pass a different name`,
        docs: 'https://ultimate.dev/errors/X_GENERATE_CONFLICT',
        at: file.path,
      });
      continue;
    }
    // Bun.write creates missing parent directories, so a generator never needs an mkdir step.
    await Bun.write(absolute, file.contents);
    written.push(file.path);
  }
  return { written, conflicts };
}

function readKind(raw: string | undefined): Generator {
  const kinds: readonly string[] = GENERATORS;
  if (raw !== undefined && kinds.includes(raw)) return raw as Generator;
  throw new UnknownCommandError({
    path: `g ${raw ?? ''}`.trim(),
    known: GENERATORS,
    suggestion: 'g resource',
  });
}

export const generateCommand: CliCommand = {
  spec: {
    name: 'g',
    aliases: ['generate'],
    summary: 'scaffold a primitive with its passing test',
    usage: 'x g resource|action|mutator|job|route|policy|entity|query|task <name> [--feature f]',
    requiresApp: true,
    flags: [
      { name: 'feature', type: 'string', summary: 'feature slice to write into' },
      { name: 'surface', type: 'string', summary: 'site | app', default: 'app' },
      { name: 'live', type: 'boolean', summary: 'subscribable query' },
      { name: 'force', type: 'boolean', summary: 'overwrite existing files' },
      { name: 'dry-run', type: 'boolean', summary: 'print the file list, write nothing' },
    ],
  },
  async run(ctx: CommandContext): Promise<CommandResult> {
    const root = requireAppRoot('g', ctx.cwd).dir;
    const kind = readKind(ctx.args.positionals[0]);
    const name = ctx.args.positionals[1];
    if (name === undefined) {
      throw new UnknownCommandError({
        path: `g ${kind}`,
        known: GENERATORS,
        suggestion: `g ${kind} <name>`,
      });
    }
    const surfaceFlag = flagString(ctx.args, 'surface');
    const featureFlag = flagString(ctx.args, 'feature');
    const files = generate({
      kind,
      name,
      ...(featureFlag === undefined ? {} : { feature: featureFlag }),
      surface: surfaceFlag === 'site' ? 'site' : 'app',
      live: flagBool(ctx.args, 'live'),
    });
    if (flagBool(ctx.args, 'dry-run')) {
      return {
        ok: true,
        command: 'g',
        summary: msg('cli.generate.wrote', { count: files.length, kind, name }),
        data: { files: files.map((file) => file.path), dryRun: true },
        lines: files.map((file) => `  + ${file.path}`),
      };
    }
    const report = await writeFiles(root, files, flagBool(ctx.args, 'force'));
    return {
      ok: report.conflicts.length === 0,
      command: 'g',
      summary: msg('cli.generate.wrote', { count: report.written.length, kind, name }),
      data: { files: report.written },
      lines: report.written.map((path) => `  + ${path}`),
      findings: report.conflicts,
    };
  },
};
