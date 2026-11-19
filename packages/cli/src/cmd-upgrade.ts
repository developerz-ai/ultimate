// `x upgrade`: one major per run. Refuse a dirty tree, write exact pins and the Bun floor, install,
// then let the CLI just installed run the gate. It never commits: git is the state between runs, so
// a hop is one reviewable commit. No `await import()` anywhere below — `bun install` replaces this
// very file under the running process when the app's own CLI is the one that was run.

// why: Bun exposes no path-join primitive; the git root and the app root are joined with paths.
import { join } from 'node:path';
import { UltimateError } from '@ultimat3/core';
import { versionAtLeast } from './app-root';
import { runUpgradeCodemods } from './cmd-upgrade-codemods';
import { upgradeSpec } from './cmd-upgrade-spec';
import type { CliCommand, CommandContext } from './command';
import { failed, ok } from './command';
import { staleTransitiveFloors } from './doctor-advisory-floors';
import { supersededFindings } from './doctor-superseded';
import { BadFlagError, BunVersionError } from './errors';
import type { Runner } from './exec';
import { execOutput } from './exec';
import { msg } from './messages';
import type { CommandResult } from './output';
import { flagBool, flagString } from './parse';
import { posixRelative } from './posix-path';
import { typescriptLags } from './typescript-floor';
import { applyAgentsLink, planAgentsLink } from './upgrade-agents-link';
import type { BunEdit, BunManual } from './upgrade-bun-floor';
import { editBunSites, floorOf, isBunSite } from './upgrade-bun-floor';
import { requireCleanTree } from './upgrade-clean-tree';
import { repoScripts, runHopGate, runRepoScripts } from './upgrade-gate';
import { EVERY_RELEASE, previewCodemods } from './upgrade-gate-codemods';
import { acquireUpgradeLock } from './upgrade-lock';
import { readManifests, readPins, rewritePins } from './upgrade-pins';
import type { UpgradeHop } from './upgrade-plan';
import { planHop, releaseOf } from './upgrade-plan';
import { publishedVersions, releaseBunRange } from './upgrade-registry';
import type { PlannedWrites } from './upgrade-report';
import { humanLines, NO_WRITES, report, thenLine } from './upgrade-report';
import { findUpgradeRoot } from './upgrade-root';
import type { GateScope } from './upgrade-scope';
import { readScope } from './upgrade-scope';
import { stopChildrenOnSignal, tagRunner, upgradeTag } from './upgrade-signals';
import type { UnfinishedHop } from './upgrade-unfinished';
import { clearUnfinished, readUnfinished, writeUnfinished } from './upgrade-unfinished';
import { elapsedLabel, HEARTBEAT_MS } from './verify-progress';
import { writeErrorLine } from './write-line';

const readTarget = (ctx: CommandContext): string | undefined => {
  const to = flagString(ctx.args, 'to');
  if (to === undefined || releaseOf(to) !== undefined) return to;
  throw new BadFlagError({
    flag: 'to',
    command: 'upgrade',
    reason: `"${to}" is not an exact release, major.minor.patch`,
    fix: 'bun pm view @ultimat3/cli versions --json   # then: x upgrade --to <one of them> --json',
  });
};

/** Everything the hop would write, decided before any of it is. `--dry-run` stops here. */
async function planWrites(input: {
  readonly runner: Runner;
  readonly root: string;
  readonly top: string;
  readonly to: string;
  readonly floor: string | undefined;
  readonly manifests: readonly { readonly file: string; readonly text: string }[];
}): Promise<PlannedWrites> {
  const { runner, root, top, to, floor, manifests } = input;
  const files = new Map<string, string>();
  for (const { file, text } of manifests) {
    const next = rewritePins(text, to);
    if (next !== text) files.set(join(root, file), next);
  }
  if (floor === undefined) return { files, edited: [], manual: [] };

  const tracked = await runner(['git', 'ls-files'], { cwd: top });
  const edited: BunEdit[] = [];
  const manual: BunManual[] = [];
  for (const path of tracked.stdout.split('\n').filter(isBunSite)) {
    const absolute = join(top, path);
    // Tracked and absent is a sparse checkout: a site this tree does not hold is not this run's.
    if (!files.has(absolute) && !(await Bun.file(absolute).exists())) continue;
    const source = files.get(absolute) ?? (await Bun.file(absolute).text());
    // Paths as the app reads them: a report's `path` is one its agent opens from the app root.
    const shown = posixRelative(root, absolute);
    const edit = editBunSites(shown, source, floor);
    edited.push(...edit.edited);
    manual.push(...edit.manual);
    if (edit.text !== source) files.set(absolute, edit.text);
  }
  return { files, edited, manual };
}

/** One `bun` step of the install, or the refusal carrying the command that undoes the pins. */
async function installStep(
  runner: Runner,
  root: string,
  to: string,
  args: readonly string[],
): Promise<void> {
  const result = await runner([process.execPath, ...args], { cwd: root });
  if (result.ok) return;
  throw new UltimateError({
    code: 'X_UPGRADE_INSTALL_FAILED',
    cause: `bun ${args.join(' ')} exited ${String(result.code)} after pinning ${to}: ${execOutput(result).slice(-800) || 'no output'}`,
    fix: 'git restore .   # undoes the pins, since the tree was clean; then fix what the cause names and re-run: x upgrade --json',
  });
}

/** `bun install` keeps what the lockfile resolves, so a patched transitive release is asked for. */
async function install(runner: Runner, root: string, to: string): Promise<void> {
  await installStep(runner, root, to, ['install']);
  const stale = await staleTransitiveFloors(root);
  if (stale.length > 0) await installStep(runner, root, to, ['update', ...stale]);
}

const stageLine = (stage: string): string => JSON.stringify({ upgrade: stage });

/**
 * Runs `work` with a line on stderr naming the stage every `HEARTBEAT_MS`: the gate's own progress
 * is captured with the child, so a harness that kills on silence would otherwise kill a healthy hop.
 */
async function withHeartbeat<T>(
  write: (line: string) => void,
  work: (stageReached: (stage: string) => void) => Promise<T>,
): Promise<T> {
  let stage = 'install';
  let began = performance.now();
  const timer = setInterval(() => {
    try {
      write(
        msg('cli.upgrade.stillRunning', {
          stage,
          elapsed: elapsedLabel(performance.now() - began),
        }),
      );
    } catch {
      // Stderr closed under the hop: nowhere left to say it, and the verdict still reaches stdout.
    }
  }, HEARTBEAT_MS);
  timer.unref();
  try {
    return await work((next) => {
      stage = next;
      began = performance.now();
      write(stageLine(next));
    });
  } finally {
    clearInterval(timer);
  }
}

/** The recorded hop this run finishes: its pins are at target and it is the hop that wrote them. */
const resumable = (
  unfinished: UnfinishedHop | undefined,
  planned: UpgradeHop,
  dryRun: boolean,
): UnfinishedHop | undefined =>
  unfinished !== undefined && planned.atTarget && !dryRun && unfinished.to === planned.to
    ? unfinished
    : undefined;

/** `YYYY-MM-DD` in UTC: the day a rebaselined floor's `why` names. */
const utcDay = (at: Date): string => at.toISOString().slice(0, 10);

export const createUpgradeCommand = (
  write: (line: string) => void,
  /** The clock a rebaselined coverage floor is dated by; a test pins it. */
  now: () => Date = () => new Date(),
): CliCommand => {
  /** One hop, under the lock and the signal handlers `run` holds around it. */
  async function runHop(
    ctx: CommandContext,
    root: string,
    app: boolean,
    to: string | undefined,
    scope: GateScope | undefined,
  ): Promise<CommandResult> {
    const dryRun = flagBool(ctx.args, 'dry-run');
    const unfinished = await readUnfinished(root);
    const top = await requireCleanTree(ctx.runner, root, unfinished);
    const manifests = await readManifests(root);
    const pins = readPins(manifests);
    // Reported, never written: a compiler is the app's to move, and the line names the command.
    const typescript = typescriptLags(manifests);
    const versions = await publishedVersions(ctx.runner, root);
    const planned = planHop({ pins, versions, ...(to === undefined ? {} : { to }) });
    // Pins at target with a hop recorded as unfinished: that hop wrote them and never reached its
    // gate. It is finished now — install, then the whole gate, every codemod (each skips a file it
    // already carried) — rather than answered done.
    const resume = resumable(unfinished, planned, dryRun);
    const hop = resume === undefined ? planned : { ...planned, from: resume.from, atTarget: false };

    if (hop.atTarget) {
      // A record for some other target is a hop since undone (`git stash`): nothing left to finish.
      if (unfinished !== undefined && !dryRun) await clearUnfinished(root);
      const then = thenLine({ hop, dryRun, app, gate: undefined, scripts: [] });
      // No version moved, so no codemod is owed: a hand run is `x upgrade codemods --from <version>`.
      const superseded = app ? await supersededFindings(root) : [];
      const summary =
        hop.next === null
          ? msg('cli.upgrade.atLatest', { version: hop.to })
          : msg('cli.upgrade.atTarget', { version: hop.to, next: hop.next });
      return ok('upgrade', summary, {
        data: report({
          hop,
          done: true,
          dryRun,
          pins,
          bunFrom: null,
          bunTo: null,
          writes: NO_WRITES,
          app,
          gate: undefined,
          scripts: [],
          then,
          typescript,
          superseded,
        }),
        lines: [
          ...typescript.map((lag) => msg('cli.upgrade.typescript', { ...lag })),
          msg('cli.upgrade.then', { then }),
        ],
      });
    }

    const bunRange =
      resume === undefined
        ? await releaseBunRange(ctx.runner, root, hop.to)
        : (resume.bunTo ?? undefined);
    const floor = floorOf(bunRange);
    // Before any write: the CLI this hop installs refuses this Bun on its first line, so the pins
    // would land and every later step would report the same `X_BUN_VERSION` as a hop gone red.
    if (floor !== undefined && !versionAtLeast(ctx.bunVersion, floor)) {
      throw new BunVersionError({ found: ctx.bunVersion, required: floor });
    }
    const writes = await planWrites({
      runner: ctx.runner,
      root,
      top,
      to: hop.to,
      floor,
      manifests,
    });
    const held = manifests.find((manifest) => manifest.file === 'package.json')?.text ?? '';
    const bunFrom =
      resume === undefined
        ? (/"engines"\s*:\s*\{[^}]*?"bun"\s*:\s*"([^"]*)"/.exec(held)?.[1] ?? null)
        : resume.bunFrom;
    const agentsMd = await planAgentsLink(root);
    const shared = {
      hop,
      pins,
      bunFrom,
      bunTo: bunRange ?? null,
      writes,
      app,
      agentsMd,
      typescript,
    };
    const scriptNames = app ? [] : repoScripts(held);

    if (dryRun) {
      const named = scriptNames.map((name) => ({ name, ok: null }));
      const then = thenLine({ hop, dryRun: true, app, gate: undefined, scripts: named });
      // This CLI's list, written nowhere: the hop itself applies the installed release's.
      const preview = app ? await previewCodemods(root, hop.from, hop.to) : undefined;
      return ok('upgrade', msg('cli.upgrade.dryRun', { from: hop.from, to: hop.to }), {
        data: report({
          ...shared,
          done: false,
          dryRun: true,
          gate: undefined,
          scripts: named,
          then,
          ...preview,
        }),
        lines: humanLines({
          hop,
          writes,
          gate: undefined,
          scripts: named,
          then,
          agentsMd,
          typescript,
          ...preview,
        }),
      });
    }

    // From the first pin written until the gate returns: a stopped hop is told apart from a done one.
    await writeUnfinished(root, {
      from: hop.from,
      to: hop.to,
      bunFrom,
      bunTo: bunRange ?? null,
      startedAt: resume?.startedAt ?? now().toISOString(),
    });
    await Promise.all(
      [...writes.files].map(async ([path, text]) => {
        await Bun.write(path, text);
      }),
    );
    await applyAgentsLink(root, agentsMd);
    const { gate, scripts } = await withHeartbeat(write, async (stageReached) => {
      stageReached('install');
      await install(ctx.runner, root, hop.to);
      if (!app) {
        const names = scriptNames;
        const ran = await runRepoScripts({
          runner: ctx.runner,
          root,
          names,
          onStage: stageReached,
        });
        return { gate: undefined, scripts: ran };
      }
      // Bun 1.4.4 counted functions differently: a hop that moves the floor re-measures coverage.
      const bunMoved =
        bunRange === undefined || bunRange === bunFrom
          ? undefined
          : { release: hop.to, bunFrom, bunTo: bunRange, today: utcDay(now()) };
      const hopGate = await runHopGate({
        runner: ctx.runner,
        root,
        onStage: stageReached,
        codemods: { from: resume === undefined ? hop.from : EVERY_RELEASE, to: hop.to },
        ...(bunMoved === undefined ? {} : { bunMoved }),
        ...(scope === undefined ? {} : { only: scope }),
      });
      return { gate: hopGate, scripts: [] };
    });
    await clearUnfinished(root);

    const redScripts = scripts.filter((script) => script.ok !== true).map((script) => script.name);
    // With no script, nothing was checked, and that is never a green.
    const done =
      gate !== undefined
        ? gate.verify.ok && gate.codemods?.failure === undefined
        : scripts.length > 0 && redScripts.length === 0;
    const then = thenLine({ hop, dryRun: false, app, gate, scripts });
    const extra = {
      data: report({ ...shared, done, dryRun: false, gate, scripts, then }),
      lines: humanLines({ hop, writes, gate, scripts, then, agentsMd, typescript }),
    };
    const span = { from: hop.from, to: hop.to };
    if (gate !== undefined) {
      const notRun = gate.verify.notRun ?? [];
      if (done && notRun.length > 0) {
        const scoped = {
          ...span,
          only: (gate.verify.only ?? []).join(','),
          notRun: notRun.join(','),
        };
        return ok('upgrade', msg('cli.upgrade.doneScoped', scoped), extra);
      }
      return done
        ? ok('upgrade', msg('cli.upgrade.done', span), extra)
        : failed(
            'upgrade',
            msg('cli.upgrade.red', { ...span, summary: gate.verify.summary }),
            extra,
          );
    }
    if (scripts.length === 0) return failed('upgrade', msg('cli.upgrade.noApp.none', span), extra);
    return done
      ? ok('upgrade', msg('cli.upgrade.noApp.done', { ...span, count: scripts.length }), extra)
      : failed(
          'upgrade',
          msg('cli.upgrade.noApp.red', { ...span, names: redScripts.join(', ') }),
          extra,
        );
  }

  return {
    spec: upgradeSpec,
    async run(ctx: CommandContext): Promise<CommandResult> {
      if (ctx.args.subcommand === 'codemods') return runUpgradeCodemods(ctx);
      const { dir: root, app } = await findUpgradeRoot(ctx.cwd);
      const to = readTarget(ctx);
      const scope = readScope(ctx, app);
      // One hop per app at a time, and a stopped hop stops its children: every spawn below is
      // tagged, and SIGINT/SIGTERM kill that tree and release the lock before the signal lands.
      const release = await acquireUpgradeLock(root);
      const tag = upgradeTag();
      const pids = new Set<number>();
      const undoSignals = stopChildrenOnSignal({ tag, pids, cleanup: release });
      try {
        const runner = tagRunner(ctx.runner, tag, ctx.env, pids);
        return await runHop({ ...ctx, runner }, root, app, to, scope);
      } finally {
        undoSignals();
        release();
      }
    },
  };
};

export const upgradeCommand: CliCommand = createUpgradeCommand(writeErrorLine);
