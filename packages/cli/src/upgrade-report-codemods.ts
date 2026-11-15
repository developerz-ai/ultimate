// The codemod half of what `x upgrade` says: one line per codemod that ran, one per file it
// changed, and each file it left for the author with the reason and the diff to apply by hand.

import type { CodemodsReport } from './codemods/engine';
import { msg } from './messages';

/** Where a hop's codemods came from: the CLI it installed, or this one when that one has none. */
export type CodemodSource = 'installed' | 'driver';

export interface HopCodemods extends CodemodsReport {
  readonly source: CodemodSource;
  /** Present when a codemod changed a `package.json` and the hop ran `bun install` again. */
  readonly reinstalled?: true;
  /** The installed CLI's codemods run failed: nothing applied, and the hop is not done. */
  readonly failure?: { readonly code: string; readonly cause: string; readonly fix: string };
}

export const codemodCounts = (
  report: CodemodsReport,
): { readonly count: number; readonly changed: number; readonly skipped: number } => ({
  count: report.applied.length,
  changed: report.applied.reduce((sum, one) => sum + one.changed.length, 0),
  skipped: report.applied.reduce((sum, one) => sum + one.skipped.length, 0),
});

export function codemodLines(report: CodemodsReport | HopCodemods | null): readonly string[] {
  if (report !== null && 'failure' in report && report.failure !== undefined) {
    return [msg('cli.upgrade.codemods.failed', { ...report.failure })];
  }
  if (report === null || report.applied.length === 0) return [];
  return [
    ...('source' in report && report.source === 'driver'
      ? [msg('cli.upgrade.codemods.fromDriver')]
      : []),
    ...report.applied.flatMap((one) => [
      msg('cli.upgrade.codemod', {
        id: one.id,
        since: one.since,
        summary: one.summary,
        changed: one.changed.length,
        skipped: one.skipped.length,
      }),
      ...one.changed.map((path) => msg('cli.upgrade.codemod.changed', { path })),
      ...one.skipped.flatMap((skip) => [
        msg('cli.upgrade.codemod.skipped', { path: skip.path, reason: skip.reason }),
        ...(skip.diff ?? '')
          .trimEnd()
          .split('\n')
          .filter((line) => line !== '')
          .map((line) => `    ${line}`),
      ]),
    ]),
  ];
}
