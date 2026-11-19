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
import { manifestSnapshot, reinstallIfMoved } from './upgrade-gate-codemods-install';
import { installMergeDrivers } from './upgrade-merge-drivers';
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

/**
 * The codes an installed CLI with no `x upgrade codemods` answers: an unknown flag or subcommand,
 * an unknown command. Only those leave the span to this CLI; any other failure is the hop's.
 */
const NO_SUBCOMMAND = new Set(['X_CLI_BAD_FLAG', 'X_CLI_UNKNOWN_COMMAND', 'X_NOT_IMPLEMENTED']);

const FAILURE = t.object({
  findings: t.array(t.object({ code: t.string, cause: t.string, fix: t.string })),
});

/** The installed CLI's own failure, when it is one: undefined when it simply lacks the subcommand. */
function failureOf(result: ExecResult): HopCodemods['failure'] {
  const parsed = FAILURE.safeParse(documentIn(result.stdout));
  if (parsed.issues !== undefined) return undefined;
  const [first] = (parsed.value as { readonly findings: NonNullable<HopCodemods['failure']>[] })
    .findings;
  return first === undefined || NO_SUBCOMMAND.has(first.code) ? undefined : first;
}

/**
 * The span's codemods, by the installed CLI (or this one, only when that one lacks the
 * subcommand), then a second `bun install` when any `package.json` moved — `reinstalled: true`.
 */
export async function applyHopCodemods(input: {
  readonly runner: Runner;
  readonly root: string;
  readonly from: string;
  readonly to: string;
}): Promise<HopCodemods> {
  const { runner, root, from, to } = input;
  const before = await manifestSnapshot(root);
  const result = await runner(
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
  );
  const answered = readCodemods(result);
  const failure = answered === undefined ? failureOf(result) : undefined;
  if (failure !== undefined) {
    return { from, to, dryRun: false, applied: [], source: 'installed', failure };
  }
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
  const reinstalled = await reinstallIfMoved({ runner, root, to, before });
  // After the install: the driver command runs the app's own `node_modules/.bin/x`.
  await installMergeDrivers(runner, root);
  return reinstalled ? { ...report, reinstalled: true } : report;
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

/** Below every release: a resumed hop reruns every codemod, which are idempotent. */
export const EVERY_RELEASE = '0.0.0';
