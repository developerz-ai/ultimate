// `x upgrade`: one major per run. Refuse a dirty tree, write exact pins and the Bun floor, install,
// then let the CLI just installed run the gate. It never commits: git is the state between runs, so
// a hop is one reviewable commit. No `await import()` anywhere below — `bun install` replaces this
// very file under the running process when the app's own CLI is the one that was run.

// why: Bun exposes no path-join primitive; the git root and the app root are joined with paths.
import { join } from 'node:path';
import { UltimateError } from '@ultimat3/core';
import { versionAtLeast } from './app-root';
import { upgradeSpec } from './cmd-upgrade-spec';
import type { CliCommand, CommandContext } from './command';
import { failed, ok } from './command';
import { BadFlagError, BunVersionError } from './errors';
import type { Runner } from './exec';
import { execOutput } from './exec';
import { msg } from './messages';
import type { CommandResult } from './output';
import { flagBool, flagString } from './parse';
import { posixRelative } from './posix-path';
import type { BunEdit, BunManual } from './upgrade-bun-floor';
import { editBunSites, floorOf, isBunSite } from './upgrade-bun-floor';
import { repoScripts, runHopGate, runRepoScripts } from './upgrade-gate';
import { readManifests, readPins, rewritePins } from './upgrade-pins';
import { planHop, releaseOf } from './upgrade-plan';
import { publishedVersions, releaseBunRange } from './upgrade-registry';
import type { PlannedWrites } from './upgrade-report';
import { humanLines, NO_WRITES, report, thenLine } from './upgrade-report';
import { findUpgradeRoot } from './upgrade-root';
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

/** The repository's root, or the refusal: git is the only record of where the walk stands. */
async function requireCleanTree(runner: Runner, root: string): Promise<string> {
  const top = await runner(['git', 'rev-parse', '--show-toplevel'], { cwd: root });
  if (!top.ok) {
    throw new UltimateError({
      code: 'X_UPGRADE_DIRTY_TREE',
      cause: `${root} is not a git repository, and a hop has to be one commit you can review or undo`,
      fix: 'git init && git add -A && git commit -m "before x upgrade"   # then: x upgrade --json',
    });
  }
  const status = await runner(['git', 'status', '--porcelain'], { cwd: root });
  const changes = status.stdout.split('\n').filter((line) => line.trim().length > 0);
  if (!status.ok || changes.length > 0) {
    throw new UltimateError({
      code: 'X_UPGRADE_DIRTY_TREE',
      cause: `${String(changes.length)} uncommitted change(s), and a hop has to be one reviewable commit: ${changes.slice(0, 5).join('; ')}`,
      fix: 'git status --short   # then commit or stash, and re-run: x upgrade --json',
    });
  }
  return top.stdout.trim();
}

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

/** `bun install`, or the refusal carrying the one command that undoes what was just written. */
async function install(runner: Runner, root: string, to: string): Promise<void> {
  const result = await runner([process.execPath, 'install'], { cwd: root });
  if (result.ok) return;
  throw new UltimateError({
    code: 'X_UPGRADE_INSTALL_FAILED',
    cause: `bun install exited ${String(result.code)} after pinning ${to}: ${execOutput(result).slice(-800) || 'no output'}`,
    fix: 'git restore .   # undoes the pins, since the tree was clean; then fix what the cause names and re-run: x upgrade --json',
  });
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

export const createUpgradeCommand = (write: (line: string) => void): CliCommand => ({
  spec: upgradeSpec,
  async run(ctx: CommandContext): Promise<CommandResult> {
    const { dir: root, app } = await findUpgradeRoot(ctx.cwd);
    const to = readTarget(ctx);
    const dryRun = flagBool(ctx.args, 'dry-run');
    const top = await requireCleanTree(ctx.runner, root);
    const manifests = await readManifests(root);
    const pins = readPins(manifests);
    const versions = await publishedVersions(ctx.runner, root);
    const hop = planHop({ pins, versions, ...(to === undefined ? {} : { to }) });

    if (hop.atTarget) {
      const then = thenLine({ hop, dryRun, app, gate: undefined, scripts: [] });
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
        }),
        lines: [msg('cli.upgrade.then', { then })],
      });
    }

    const bunRange = await releaseBunRange(ctx.runner, root, hop.to);
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
    const bunFrom = /"engines"\s*:\s*\{[^}]*?"bun"\s*:\s*"([^"]*)"/.exec(held)?.[1] ?? null;
    const shared = { hop, pins, bunFrom, bunTo: bunRange ?? null, writes, app };
    const scriptNames = app ? [] : repoScripts(held);

    if (dryRun) {
      const named = scriptNames.map((name) => ({ name, ok: null }));
      const then = thenLine({ hop, dryRun: true, app, gate: undefined, scripts: named });
      return ok('upgrade', msg('cli.upgrade.dryRun', { from: hop.from, to: hop.to }), {
        data: report({
          ...shared,
          done: false,
          dryRun: true,
          gate: undefined,
          scripts: named,
          then,
        }),
        lines: humanLines({ hop, writes, gate: undefined, scripts: named, then }),
      });
    }

    await Promise.all(
      [...writes.files].map(async ([path, text]) => {
        await Bun.write(path, text);
      }),
    );
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
      const hopGate = await runHopGate({ runner: ctx.runner, root, onStage: stageReached });
      return { gate: hopGate, scripts: [] };
    });

    const redScripts = scripts.filter((script) => script.ok !== true).map((script) => script.name);
    // With no script, nothing was checked, and that is never a green.
    const done =
      gate !== undefined ? gate.verify.ok : scripts.length > 0 && redScripts.length === 0;
    const then = thenLine({ hop, dryRun: false, app, gate, scripts });
    const extra = {
      data: report({ ...shared, done, dryRun: false, gate, scripts, then }),
      lines: humanLines({ hop, writes, gate, scripts, then }),
    };
    const span = { from: hop.from, to: hop.to };
    if (gate !== undefined) {
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
  },
});

export const upgradeCommand: CliCommand = createUpgradeCommand(writeErrorLine);
