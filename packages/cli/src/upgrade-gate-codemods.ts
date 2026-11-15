// A hop's codemods, applied by the CLI the hop just installed (`x upgrade codemods`): that CLI holds
// the target release's list, which this one may predate. An installed CLI with no such subcommand
// (one older than the engine) answers no document; this CLI applies its own list instead.

// why: Bun exposes no path-join primitive; the installed bin is assembled from the app root.
import { join } from 'node:path';
import { UltimateError } from '@ultimat3/core';
import { t } from '@ultimat3/schema';
import { CODEMODS } from './codemods';
import type { CodemodsReport } from './codemods/engine';
import { runCodemods } from './codemods/engine';
import { fsCodemodApp } from './codemods/engine-fs';
import { supersededFindings } from './doctor-superseded';
import type { ExecResult, Runner } from './exec';
import { execOutput } from './exec';
import { LOCAL_CLI_BIN } from './local-cli';
import type { Finding } from './output';
import { documentIn } from './upgrade-document';
import type { HopCodemods } from './upgrade-report-codemods';

const SKIP = t.object({ path: t.string, reason: t.string, diff: t.optional(t.string) });
const OUTCOME = t.object({
  id: t.string,
  since: t.string,
  summary: t.string,
  changed: t.array(t.string),
  skipped: t.array(SKIP),
});
const DOCUMENT = t.object({
  data: t.object({
    codemods: t.object({
      from: t.string,
      to: t.string,
      dryRun: t.boolean,
      applied: t.array(OUTCOME),
    }),
  }),
});

/** The installed CLI's report, or undefined when it answered none this one can read. */
export function readCodemods(result: ExecResult): CodemodsReport | undefined {
  const parsed = DOCUMENT.safeParse(documentIn(result.stdout));
  if (!result.ok || parsed.issues !== undefined) return undefined;
  return (parsed.value as { readonly data: { readonly codemods: CodemodsReport } }).data.codemods;
}

/** A codemod moved a dependency: the lockfile and node_modules follow before anything reads them. */
const MANIFEST = /(?:^|\/)package\.json$/;

async function reinstall(runner: Runner, root: string, to: string): Promise<void> {
  const result = await runner([process.execPath, 'install'], { cwd: root });
  if (result.ok) return;
  throw new UltimateError({
    code: 'X_UPGRADE_INSTALL_FAILED',
    cause: `bun install exited ${String(result.code)} after the ${to} codemods moved a package.json: ${execOutput(result).slice(-800) || 'no output'}`,
    fix: 'git diff -- "*package.json"   # the codemods\' edits; fix what the cause names, then: bun install && x upgrade --json',
  });
}

/**
 * The span's codemods, by the installed CLI (or this one, when that one has none), then a second
 * `bun install` when any of them changed a `package.json` — `reinstalled: true` says so.
 */
export async function applyHopCodemods(input: {
  readonly runner: Runner;
  readonly root: string;
  readonly from: string;
  readonly to: string;
}): Promise<HopCodemods> {
  const { runner, root, from, to } = input;
  const answered = readCodemods(
    await runner(
      [
        process.execPath,
        join(root, LOCAL_CLI_BIN),
        'upgrade',
        'codemods',
        '--from',
        from,
        '--to',
        to,
        '--json',
      ],
      { cwd: root },
    ),
  );
  const report: HopCodemods =
    answered !== undefined
      ? { ...answered, source: 'installed' }
      : {
          ...(await runCodemods({
            app: fsCodemodApp(root),
            codemods: CODEMODS,
            from,
            to,
            dryRun: false,
          })),
          source: 'driver',
        };
  if (!report.applied.some((one) => one.changed.some((path) => MANIFEST.test(path)))) return report;
  await reinstall(runner, root, to);
  return { ...report, reinstalled: true };
}

/**
 * `x upgrade --dry-run`'s view: this CLI's codemods over the span, written nowhere, and the
 * superseded workarounds the tree holds now. The hop itself applies the installed release's list.
 */
export async function previewCodemods(
  root: string,
  from: string,
  to: string,
): Promise<{ readonly codemods: HopCodemods; readonly superseded: readonly Finding[] }> {
  const own = await runCodemods({
    app: fsCodemodApp(root),
    codemods: CODEMODS,
    from,
    to,
    dryRun: true,
  });
  return { codemods: { ...own, source: 'driver' }, superseded: await supersededFindings(root) };
}

/** Below every release: an app already at its target reruns every codemod, which are idempotent. */
export const EVERY_RELEASE = '0.0.0';

/**
 * No version moves, and still no copy of an old template stays: every codemod up to the release
 * the app is on, through the installed CLI as a hop would (a dry run previews this CLI's list).
 * Each is idempotent, so one already applied is a run that changes nothing.
 */
export async function atTargetCodemods(input: {
  readonly runner: Runner;
  readonly root: string;
  readonly to: string;
  readonly dryRun: boolean;
}): Promise<{ readonly codemods: HopCodemods; readonly superseded: readonly Finding[] }> {
  const { runner, root, to } = input;
  if (input.dryRun) return previewCodemods(root, EVERY_RELEASE, to);
  const codemods = await applyHopCodemods({ runner, root, from: EVERY_RELEASE, to });
  return { codemods, superseded: await supersededFindings(root) };
}
