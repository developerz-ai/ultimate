#!/usr/bin/env bun
// Answer whether Ultimate is finished: one verdict per row of the finished table
// (`docs/history/finished.md`), each a read of the repository or of GitHub, never prose. `--check`
// exits non-zero unless every row is green; a row whose source could not be read is `unverdicted`,
// and that fails `--check` too. Not an `x verify` step: half its rows read GitHub.
//
//   bun run finished [--check] [--json]

import { renderThrowable } from '@ultimat3/core';
import { PLANNED_COMMANDS, PLANNED_SUBCOMMANDS } from '../packages/cli/src/cmd-planned';
import { NEW_SHAPES } from '../packages/cli/src/new-shapes';
import { VERIFY_STEP_NAMES } from '../packages/cli/src/verify-step';
import { gateRow } from './finished-gate';
import { compatRow, flakeRow, shapesRow } from './finished-github';
import { lanesRow } from './finished-lanes';
import { ledgerRow } from './finished-ledger';
import { loopRow } from './finished-loop';
import { pinsRow } from './finished-pins';
import { readGatedApps, readPinTables, readTrackers } from './finished-reads';
import { KNOWN_GAPS_PAGE, PLANNED_FILE, plannedRow, stubRow } from './finished-repo';
import type { FinishedRow, FinishedRowId, Runner } from './finished-rule';
import { FINISHED_ROW_IDS, stringField, unverdicted } from './finished-rule';
import { parseScriptArgs } from './lib/args';
import { shippedSources } from './lib/corpus';
import type { Finding, ScriptResult } from './lib/log';
import { report } from './lib/log';
import { GH_TIMEOUT_MS, gh } from './lib/release-due-gh';
import { repoRoot, run } from './lib/run';
import { ScriptError } from './lib/script-error';

const SCRIPT = 'finished';

/** What the GitHub and npm rows run, and the clock: a test answers each from a fixture. */
export interface FinishedSeams {
  readonly gh?: Runner;
  readonly npm?: Runner;
  readonly nowMs?: number;
}

const npm: Runner = (args, cwd) => run(['npm', ...args], { cwd, timeoutMs: GH_TIMEOUT_MS });

const text = async (root: string, path: string): Promise<string> => {
  const file = Bun.file(`${root}/${path}`);
  return (await file.exists()) ? file.text() : '';
};

/** Every row, in the table's order. A row that throws is unverdicted — never skipped, never green. */
export async function finishedRows(
  root: string,
  seams: FinishedSeams = {},
): Promise<readonly FinishedRow[]> {
  const ghRun = seams.gh ?? gh;
  const nowMs = seams.nowMs ?? Date.now();
  const knownGaps = await text(root, KNOWN_GAPS_PAGE);
  const readers: Readonly<Record<FinishedRowId, () => Promise<FinishedRow>>> = {
    'no-stub': async () => stubRow(await shippedSources(root), knownGaps),
    'no-planned-command': async () =>
      plannedRow({
        commands: PLANNED_COMMANDS.map((one) => one.name),
        subcommands: PLANNED_SUBCOMMANDS.map((one) => `${one.command} ${one.subcommand}`),
        source: await text(root, PLANNED_FILE),
      }),
    'every-shape-gates': () => shapesRow(NEW_SHAPES, root, ghRun),
    'gate-whole': async () => gateRow(await readGatedApps(root), VERIFY_STEP_NAMES),
    'no-exemption-debt': async () => pinsRow(await readPinTables(root)),
    'tests-deterministic': () => flakeRow(root, ghRun, nowMs),
    'range-tested': () => compatRow(root, ghRun, nowMs),
    'lanes-exist': async () => {
      const core: unknown = await Bun.file(`${root}/packages/core/package.json`).json();
      return lanesRow(stringField(core, 'version') ?? '', root, {
        gh: ghRun,
        npm: seams.npm ?? npm,
      });
    },
    'one-ledger': async () => ledgerRow(await readTrackers(root), knownGaps),
    'loop-closed': () => loopRow(root, ghRun),
  };
  const rows: FinishedRow[] = [];
  for (const id of FINISHED_ROW_IDS) {
    try {
      // Own keys only: `id` comes from FINISHED_ROW_IDS, and a table must never answer from Object's.
      const read = Object.hasOwn(readers, id) ? readers[id] : undefined;
      rows.push(
        read === undefined ? unverdicted(id, 'the reader table', 'no reader') : await read(),
      );
    } catch (cause) {
      rows.push(unverdicted(id, `the ${id} reader`, renderThrowable(cause)));
    }
  }
  return rows;
}

/** The result `--check` reports: `ok` only when every row is green. Without it, always `ok`. */
export function finishedResult(rows: readonly FinishedRow[], check: boolean): ScriptResult {
  const count = (verdict: FinishedRow['verdict']): number =>
    rows.filter((row) => row.verdict === verdict).length;
  const finished = rows.length > 0 && count('green') === rows.length;
  const findings: readonly Finding[] = rows.flatMap((row) => row.findings);
  return {
    ok: finished || !check,
    script: SCRIPT,
    summary: `${finished ? 'finished' : 'not finished'}: ${count('green')} green, ${count('red')} red, ${count('unverdicted')} unverdicted of ${rows.length} rows`,
    findings,
    lines: rows.map((row) => `  ${row.row.padEnd(20)} ${row.verdict.padEnd(11)} ${row.reason}`),
    data: { finished, rows },
  };
}

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2), {
    names: ['check'],
    refuse: (unknown) =>
      new ScriptError({
        code: 'X_CLI_BAD_FLAG',
        cause: `finished reads --check and --json only, and was given --${unknown.join(', --')}`,
        fix: 'bun run scripts/finished.ts --check --json',
      }),
  });
  const rows = await finishedRows(repoRoot());
  report(finishedResult(rows, args.flags.has('check')), args.json);
}
