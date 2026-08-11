// `x build --target docker|binary|static` — three targets, no platform primitives. Deploy anywhere
// means "anywhere that runs a container or a binary"; nothing here knows the name of a cloud.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { requireAppRoot } from './app-root';
import { runVerify } from './cmd-verify';
import type { CliCommand, CommandContext } from './command';
import { BuildEntryMissingError, UnknownCommandError } from './errors';
import { execOutput } from './exec';
import { msg } from './messages';
import type { CommandResult, Finding } from './output';
import { flagString } from './parse';

export const BUILD_TARGETS = ['docker', 'binary', 'static'] as const;

export type BuildTarget = (typeof BUILD_TARGETS)[number];

export function readTarget(raw: string | undefined): BuildTarget {
  const targets: readonly string[] = BUILD_TARGETS;
  if (raw === undefined) return 'docker';
  if (targets.includes(raw)) return raw as BuildTarget;
  throw new UnknownCommandError({
    path: `build --target ${raw}`,
    known: BUILD_TARGETS,
    suggestion: 'build --target docker',
  });
}

/**
 * The one file each target builds from, app-root-relative and POSIX. One table, because `x build`
 * has to refuse a missing entry by name before it spawns anything, and the spawned command has to
 * name the same file — a second copy is how `binary` came to compile a path `x new` never wrote.
 */
export const BUILD_ENTRY: Readonly<Record<BuildTarget, string>> = {
  docker: 'docker/Dockerfile',
  binary: 'apps/web/server.ts',
  static: 'apps/web/prerender.ts',
};

/** Absolute path of the target's entry, or the error that names the file and what writes it. */
export function requireEntry(root: string, target: BuildTarget): string {
  const entry = BUILD_ENTRY[target];
  const absolute = join(root, entry);
  if (!existsSync(absolute)) throw new BuildEntryMissingError({ target, entry });
  return absolute;
}

/** One image for every role; ROLE selects behaviour at start, so there is one artifact to promote. */
export function dockerArgs(root: string, tag: string): readonly string[] {
  return ['docker', 'build', '-f', join(root, BUILD_ENTRY.docker), '-t', tag, root];
}

export function binaryArgs(root: string, out: string): readonly string[] {
  return [
    'bun',
    'build',
    '--compile',
    '--minify',
    join(root, BUILD_ENTRY.binary),
    '--outfile',
    out,
  ];
}

export function staticArgs(root: string, out: string): readonly string[] {
  return ['bun', 'run', join(root, BUILD_ENTRY.static), '--out', out];
}

export function argsFor(
  target: BuildTarget,
  paths: { readonly root: string; readonly tag: string; readonly out: string },
): readonly string[] {
  if (target === 'docker') return dockerArgs(paths.root, paths.tag);
  if (target === 'binary') return binaryArgs(paths.root, paths.out);
  return staticArgs(paths.root, paths.out);
}

export const buildCommand: CliCommand = {
  spec: {
    name: 'build',
    summary: 'build a container image, a single binary, or a prerendered static site',
    usage: 'x build --target docker|binary|static [--tag name] [--out path] [--json]',
    requiresApp: true,
    flags: [
      { name: 'target', type: 'string', summary: 'docker | binary | static', default: 'docker' },
      { name: 'tag', type: 'string', summary: 'image tag (docker target)' },
      { name: 'out', type: 'string', summary: 'output path (binary and static targets)' },
    ],
  },
  async run(ctx: CommandContext): Promise<CommandResult> {
    const root = requireAppRoot('build', ctx.cwd).dir;
    const target = readTarget(flagString(ctx.args, 'target'));
    // Before the gate, not after: an entry the app does not have cannot be produced by a green
    // typecheck, and eight seconds of `tsc` ahead of "that file does not exist" is eight seconds
    // an agent spends on the wrong question.
    requireEntry(root, target);

    // Run static verify steps before building.
    const staticSteps = ['typecheck', 'lint', 'boundaries', 'filesize', 'package-shape', 'errors'];
    const verifySteps = (await import('./cmd-verify')).VERIFY_STEPS.filter((step) =>
      staticSteps.includes(step.name),
    );
    const verifyResult = await runVerify(verifySteps, { root, runner: ctx.runner });
    if (!verifyResult.ok) {
      return verifyResult;
    }

    const out =
      flagString(ctx.args, 'out') ?? join(root, '.x', target === 'static' ? 'static' : 'app');
    const tag = flagString(ctx.args, 'tag') ?? 'ultimate-app:dev';
    const command = argsFor(target, { root, tag, out });
    const result = await ctx.runner(command, { cwd: root });
    const findings: readonly Finding[] = result.ok
      ? []
      : [
          {
            code: 'X_BUILD_FAILED',
            cause: `${command.join(' ')} exited ${result.code}`,
            fix: target === 'docker' ? 'x doctor --json && docker info' : 'x verify --json',
            docs: 'https://ultimate.dev/errors/X_BUILD_FAILED',
          },
        ];
    return {
      ok: result.ok,
      command: 'build',
      summary: msg('cli.build.done', { target }),
      findings,
      data: { target, artifact: target === 'docker' ? tag : out, durationMs: result.durationMs },
      lines: result.ok ? [] : execOutput(result).split('\n'),
    };
  },
};
