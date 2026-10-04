// `x build --target docker|binary|static|prebuilt` — no platform primitives. Deploy anywhere means
// "anywhere that runs a container or a binary"; nothing here knows the name of a cloud. `prebuilt`
// is the docker target's other half: the line the Dockerfile runs INSIDE the image build.

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ERROR_DOCS_URL, frameworkVersion, UltimateError, VERSION_DEFINE } from '@ultimat3/core';
import { requireAppRoot } from './app-root';
import { buildSpec } from './cmd-build-spec';
import { runVerify } from './cmd-verify';
import type { CliCommand, CommandContext } from './command';
import { externalArgs } from './compile-externals';
import { BadFlagError, UnknownCommandError } from './errors';
import type { ExecResult } from './exec';
import { execOutput } from './exec';
import { msg } from './messages';
import type { CommandResult } from './output';
import type { ParsedArgs } from './parse';
import { flagString } from './parse';
import { PREBUILT_DIR } from './serve-prebuilt-paths';
import { quoteArg } from './shell-quote';
import type { StaticReport } from './static-report';
import {
  readStaticReport,
  removeStaticReport,
  renderStaticReport,
  staticReportData,
} from './static-report';
import type { VerifyStepName } from './verify-step';

/**
 * A build target names an entry file the app does not have. `x build` refuses before it spawns the
 * builder: `bun build`'s own "module not found" says nothing about which file an Ultimate app is
 * supposed to own, and `docker build`'s says nothing about which target wanted it.
 */
export class BuildEntryMissingError extends UltimateError {
  constructor(input: { target: string; entry: string }) {
    super({
      code: 'X_BUILD_ENTRY_MISSING',
      cause: `x build --target ${input.target} builds from ${input.entry}, and the app does not have it`,
      fix: `x new scratch-app --dry-run --json   # its file list carries ${input.entry}; copy that file into this app`,
    });
  }
}

export const BUILD_TARGETS = ['docker', 'binary', 'static', 'prebuilt'] as const;

export type BuildTarget = (typeof BUILD_TARGETS)[number];

/** The targets whose builder is a subprocess. `prebuilt` is this process, inside `docker build`. */
export type SpawnedTarget = Exclude<BuildTarget, 'prebuilt'>;

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
  // What boots from the store: an image with no server entry has nothing to prebuild for.
  prebuilt: 'apps/web/server.ts',
};

/** Absolute path of the target's entry, or the error that names the file and what writes it. */
export function requireEntry(root: string, target: BuildTarget): string {
  const entry = BUILD_ENTRY[target];
  const absolute = join(root, entry);
  if (!existsSync(absolute)) throw new BuildEntryMissingError({ target, entry });
  return absolute;
}

/**
 * One image for every role; ROLE selects behaviour at start, so there is one artifact to promote.
 * `BUILD_ID` is the manifest's own build id, passed as the build arg the scaffolded Dockerfile
 * declares: without it the image's `BUILD_ID` was empty and every role computed one at boot, so
 * two replicas of one image could disagree about the id their clients are served against.
 */
export function dockerArgs(root: string, tag: string, buildId: string): readonly string[] {
  return [
    'docker',
    'build',
    '-f',
    join(root, BUILD_ENTRY.docker),
    '--build-arg',
    `BUILD_ID=${buildId}`,
    '-t',
    tag,
    root,
  ];
}

/**
 * The define is not optional. A single-file executable carries no `package.json`, so
 * `frameworkVersion()` has nothing to read and throws — which is exactly how this target came to
 * compile an artifact that could never boot. The value is this CLI's own `@ultimat3/core`, which is
 * the app's too: the packages release in lockstep and `x new` pins them together.
 *
 * `externalArgs()` is not optional either, and for the opposite reason: it names the one specifier
 * this graph must NOT resolve. `apps/web/server.ts` reaches `serve.ts`, which reaches the island
 * builder, which reaches `@babel/core` — whose `.cts`-config loader requires a package we
 * deliberately do not install. Bun 1.3 fails the compile on it. See `compile-externals.ts`.
 */
export function binaryArgs(root: string, out: string): readonly string[] {
  return [
    'bun',
    'build',
    '--compile',
    '--minify',
    '--define',
    `${VERSION_DEFINE}=${JSON.stringify(frameworkVersion())}`,
    ...externalArgs(),
    join(root, BUILD_ENTRY.binary),
    '--outfile',
    out,
  ];
}

export function staticArgs(root: string, out: string): readonly string[] {
  return ['bun', 'run', join(root, BUILD_ENTRY.static), '--out', out];
}

export function argsFor(
  target: SpawnedTarget,
  paths: {
    readonly root: string;
    readonly tag: string;
    readonly out: string;
    /** The docker target's `BUILD_ID` build arg — `appManifest(root)`'s own. */
    readonly buildId?: string;
  },
): readonly string[] {
  if (target === 'docker') return dockerArgs(paths.root, paths.tag, paths.buildId ?? 'dev');
  if (target === 'binary') return binaryArgs(paths.root, paths.out);
  return staticArgs(paths.root, paths.out);
}

/**
 * The static gate refused, so nothing was built. Reported under `build`, not `verify`: `command`
 * is the field an agent keys `--json` off, and answering `"verify"` sent it to re-run a gate it
 * never asked for while hiding that the build had not started. The steps and the summary are the
 * gate's own — they are what says which check to fix.
 */
export function preflightResult(verify: CommandResult): CommandResult {
  return { ...verify, command: 'build' };
}

/**
 * The build's result from the builder's, kept pure so the two things a reader acts on — the
 * summary line and the `--json` payload — are testable without spawning `docker`.
 *
 * `summary` used to be `msg('cli.build.done')` whatever the exit code, so a failed build printed
 * `✗ built docker`; and the builder's own logs went only into `lines`, which is declared human-only
 * and which `renderJson` drops — so CI, which runs `--json`, got the exit code and nothing to act
 * on. The output now rides in `data` and `lines` renders that same string.
 *
 * `report` is the static target's inventory, and BOTH renderers get it: `--json` is the house rule,
 * but an agent reading terminal output is the primary developer here, so a silent human path is the
 * same defect in a different costume. `lines` still carries nothing `data` does not (#242).
 */
export function buildResult(input: {
  readonly target: BuildTarget;
  readonly artifact: string;
  readonly command: readonly string[];
  readonly result: ExecResult;
  readonly report?: StaticReport;
}): CommandResult {
  const { report, result, target } = input;
  const output = result.ok ? '' : execOutput(result);
  return {
    ok: result.ok,
    command: 'build',
    summary: msg(result.ok ? 'cli.build.done' : 'cli.build.failed', { target }),
    findings: result.ok
      ? []
      : [
          {
            code: 'X_BUILD_FAILED',
            cause: `${input.command.join(' ')} exited ${result.code}`,
            fix: target === 'docker' ? 'x doctor --json && docker info' : 'x verify --json',
            docs: ERROR_DOCS_URL,
          },
        ],
    data: {
      target,
      artifact: input.artifact,
      durationMs: result.durationMs,
      ...(result.ok ? {} : { output }),
      ...staticReportData(report),
    },
    lines: result.ok
      ? report === undefined
        ? []
        : renderStaticReport(report)
      : output.split('\n'),
  };
}

/** The flags only some targets read. */
const TARGET_SCOPED_FLAGS = ['tag', 'out', 'preflight'] as const;

type TargetScopedFlag = (typeof TARGET_SCOPED_FLAGS)[number];

/** The optional flags each target READS. One table, so a flag cannot be read by one and ignored. */
const TARGET_FLAGS: ReadonlyMap<BuildTarget, readonly TargetScopedFlag[]> = new Map([
  ['docker', ['tag', 'preflight']],
  ['binary', ['out', 'preflight']],
  ['static', ['out', 'preflight']],
  // The boot reads ONE place, and the image holds no devDependencies to run a gate with.
  ['prebuilt', []],
]);

/** Why a target takes no `--<flag>`, in the words its refusal prints. */
const UNREAD_BECAUSE: Readonly<Record<TargetScopedFlag, string>> = {
  tag: 'only the docker target tags an image',
  out: 'the docker target writes an image, not a path',
  preflight: 'the prebuilt target runs no gate: `x verify` ran before `docker build` was called',
};

/**
 * A flag the chosen target never reads is refused before the gate runs. Accepted and dropped, it
 * printed a green build: `--out dist` on `docker` and `--tag` on `binary` read as if they landed.
 */
function refuseUnreadFlags(args: ParsedArgs, target: BuildTarget): void {
  for (const flag of TARGET_SCOPED_FLAGS) {
    if (!args.flags.has(flag) || TARGET_FLAGS.get(target)?.includes(flag) === true) continue;
    throw new BadFlagError({
      flag,
      command: 'build',
      reason:
        target === 'prebuilt' && flag !== 'preflight'
          ? `the prebuilt target writes ${PREBUILT_DIR}, the one place a container boots from, and takes no --${flag}`
          : `--target ${target} never reads it: ${UNREAD_BECAUSE[flag]}`,
      fix: `x build --target ${quoteArg(target)}`,
    });
  }
}

/**
 * `x build --target prebuilt`: the island chunks and compiled stylesheets, written by the process
 * `docker build` runs after the source is copied in. No gate and no subprocess — the image holds
 * no devDependencies to typecheck with, and `x verify` ran before `docker build` was called.
 *
 * A module that would not import fails the image build rather than warning into a build log
 * nobody reads: its stylesheets are missing from the store, and every pod would compile them.
 */
async function buildPrebuilt(root: string): Promise<CommandResult> {
  const started = Bun.nanoseconds();
  const { prebuildImage } = await import('./image-prepare');
  const built = await prebuildImage(root);
  const ok = built.findings.length === 0;
  return {
    ok,
    command: 'build',
    summary: msg(ok ? 'cli.build.done' : 'cli.build.failed', { target: 'prebuilt' }),
    findings: built.findings,
    data: {
      target: 'prebuilt',
      artifact: built.dir,
      durationMs: Math.round((Bun.nanoseconds() - started) / 1e6),
      islands: built.islands,
      stylesheets: built.stylesheets,
    },
    lines: [],
  };
}

/** The static steps `x build` runs before it builds, and `--no-preflight` leaves to the gate. */
export const PREFLIGHT_STEPS: readonly VerifyStepName[] = [
  'typecheck',
  'lint',
  'boundaries',
  'filesize',
  'package-shape',
  'errors',
];

export const buildCommand: CliCommand = {
  spec: buildSpec,
  async run(ctx: CommandContext): Promise<CommandResult> {
    const root = requireAppRoot('build', ctx.cwd).dir;
    const target = readTarget(flagString(ctx.args, 'target'));
    // Before the gate, not after: an entry the app does not have cannot be produced by a green
    // typecheck, and eight seconds of `tsc` ahead of "that file does not exist" is eight seconds
    // an agent spends on the wrong question.
    requireEntry(root, target);
    refuseUnreadFlags(ctx.args, target);
    if (target === 'prebuilt') return buildPrebuilt(root);

    // Run static verify steps before building — unless the caller is a gate that runs the same
    // six steps itself right after (`bin/check`: `x build --no-preflight && x verify`), where the
    // preflight was the same ~17 s of typecheck/lint/scans paid twice per run. The default stays
    // safe: a bare `x build` never ships an artifact from a tree that does not typecheck.
    const preflight = ctx.args.flags.get('preflight') !== false;
    if (preflight) {
      const verifySteps = (await import('./cmd-verify')).VERIFY_STEPS.filter((step) =>
        PREFLIGHT_STEPS.includes(step.name),
      );
      const verifyResult = await runVerify(verifySteps, { root, runner: ctx.runner, env: ctx.env });
      if (!verifyResult.ok) {
        return preflightResult(verifyResult);
      }
    }

    // A relative `--out` is a path the caller typed from where they stand, so it resolves against
    // the cwd — against the root it landed somewhere else whenever `x build` ran from `apps/web`.
    const outFlag = flagString(ctx.args, 'out');
    const out =
      outFlag === undefined
        ? join(root, '.x', target === 'static' ? 'static' : 'app')
        : resolve(ctx.cwd, outFlag);
    const tag = flagString(ctx.args, 'tag') ?? 'ultimate-app:dev';
    // The docker target stamps the manifest's build id into the image, so no role derives one at
    // boot. The island chunks and stylesheets are the image build's own (`--target prebuilt`).
    const buildId =
      target === 'docker' ? await (await import('./image-prepare')).imageBuildId(root) : undefined;
    const command = argsFor(target, {
      root,
      tag,
      out,
      ...(buildId === undefined ? {} : { buildId }),
    });
    // Removed BEFORE the builder runs, so a build that writes no inventory can never be reported
    // with the last one's: a stale emitted list is worse than none, because it reads as this run's.
    if (target === 'static') await removeStaticReport(root);
    const result = await ctx.runner(command, { cwd: root });
    // `prerenderSite` writes it; an app whose `apps/web/prerender.ts` does not call that writes no
    // `.x/build-stats.json` either, and `x verify`'s `budgets` step already reds that app with
    // `X_BUDGET_UNMEASURED` — so the absence needs no second code here.
    const report = target === 'static' && result.ok ? await readStaticReport(root) : undefined;
    return buildResult({
      target,
      artifact: target === 'docker' ? tag : out,
      command,
      result,
      ...(report === undefined ? {} : { report }),
    });
  },
};
