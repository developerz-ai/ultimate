// A hop's codemods, applied by the CLI the hop just installed (`x upgrade codemods`): that CLI holds
// the target release's list, which this one may predate. An installed CLI with no such subcommand
// (one older than the engine) answers no document; this CLI applies its own list instead.

// why: Bun exposes no path-join primitive; the installed bin is assembled from the app root.
import { join } from 'node:path';
import { t } from '@ultimat3/schema';
import { CODEMODS } from './codemods';
import type { CodemodsReport } from './codemods/engine';
import { runCodemods } from './codemods/engine';
import { fsCodemodApp } from './codemods/engine-fs';
import { supersededFindings } from './doctor-superseded';
import type { ExecResult, Runner } from './exec';
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

export async function applyHopCodemods(input: {
  readonly cli: (args: readonly string[]) => Promise<ExecResult>;
  readonly root: string;
  readonly from: string;
  readonly to: string;
}): Promise<HopCodemods> {
  const { from, to } = input;
  const answered = readCodemods(
    await input.cli(['upgrade', 'codemods', '--from', from, '--to', to, '--json']),
  );
  if (answered !== undefined) return { ...answered, source: 'installed' };
  const own = await runCodemods({
    app: fsCodemodApp(input.root),
    codemods: CODEMODS,
    from,
    to,
    dryRun: false,
  });
  return { ...own, source: 'driver' };
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
  const codemods = await applyHopCodemods({
    cli: (args) => runner([process.execPath, join(root, LOCAL_CLI_BIN), ...args], { cwd: root }),
    root,
    from: EVERY_RELEASE,
    to,
  });
  return { codemods, superseded: await supersededFindings(root) };
}
