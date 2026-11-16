// The finished table's vocabulary: its rows in order, the fact and command each one states, and
// the three verdicts a row can carry. `green` is only ever a fact read; a row whose source could
// not be read is `unverdicted`, which `--check` refuses exactly like `red`.

import { jsonDocument } from './lib/health-narrow';
import type { Finding } from './lib/log';
import type { RunResult } from './lib/run';

export const FINISHED_ROW_IDS = [
  'no-stub',
  'no-planned-command',
  'every-shape-gates',
  'gate-whole',
  'no-exemption-debt',
  'tests-deterministic',
  'range-tested',
  'lanes-exist',
  'one-ledger',
  'loop-closed',
] as const;

export type FinishedRowId = (typeof FINISHED_ROW_IDS)[number];
export type FinishedVerdict = 'green' | 'red' | 'unverdicted';

export interface FinishedRow {
  readonly row: FinishedRowId;
  readonly verdict: FinishedVerdict;
  readonly reason: string;
  /** Each red fact as an instruction; for `unverdicted`, the read that failed. Empty when green. */
  readonly findings: readonly Finding[];
}

/** A subprocess the GitHub and npm rows run: injected, so a test answers from a fixture. */
export type Runner = (args: readonly string[], cwd: string) => Promise<RunResult>;

const SCRIPT_AT = 'scripts/finished.ts';
export const RERUN = 'bun run scripts/finished.ts --check --json';

export const green = (row: FinishedRowId, reason: string): FinishedRow => ({
  row,
  verdict: 'green',
  reason,
  findings: [],
});

export const red = (
  row: FinishedRowId,
  reason: string,
  findings: readonly Finding[],
): FinishedRow => ({ row, verdict: 'red', reason, findings });

/** A source the row could not read: never green, and the finding names the command to repair. */
export const unverdicted = (row: FinishedRowId, command: string, detail: string): FinishedRow => ({
  row,
  verdict: 'unverdicted',
  reason: `${command} answered nothing readable: ${detail}`,
  findings: [
    {
      code: 'X_FINISHED_UNVERDICTED',
      cause: `the ${row} row could not read ${command} (${detail}), so no verdict for it exists`,
      fix: `gh auth status   # a gh logged in to github.com with read access, then: ${RERUN}`,
      at: SCRIPT_AT,
    },
  ],
});

/**
 * The JSON document a `gh`/`npm` answer printed, or `undefined`. A failed exit is no read, whatever
 * it printed: `run()` joins stderr into the output, and an error page is not an empty list.
 */
export const parsedOutput = (result: RunResult): unknown =>
  result.ok ? jsonDocument(result.output) : undefined;

export const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const stringField = (value: unknown, key: string): string | undefined => {
  const field = isRecord(value) ? value[key] : undefined;
  return typeof field === 'string' ? field : undefined;
};
