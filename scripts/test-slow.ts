#!/usr/bin/env bun
// Refuse a test file whose measured wall time is over the budget with no stated reason. One file
// that grows past its shard's share sets CI's wall time on its own, and nothing said so: the unit
// shards ran 238–415 s on main (run 43903381662, 2026-11-16), led by single files of 21–41 s.
//
// The time is read from the committed weights (`scripts/lib/ci/test-weights.json`, written from a
// CI run by `scripts/test-weights.ts`), never timed here: one tree, one verdict. A file
// over `SLOW_TEST_BUDGET_MS` carries `// slow: <reason>` in its header comment, saying why the time
// is the work its assertions need — reviewable, and the escape the owner's rule leaves ("no sleeps,
// stub long work"). A reason on a file measured under half the budget is stale: it would let the
// file grow back unseen. A weight for a file the tree no longer holds is the writer's to drop, and
// is reported as data only — a split or a rename must not turn the gate red until CI re-measures.
//
//   bun run scripts/test-slow.ts [--json]

import { parseScriptArgs } from './lib/args';
import { WEIGHTS_FILE } from './lib/ci/test-weights';
import { corpus } from './lib/corpus';
import type { Finding } from './lib/log';
import { report } from './lib/log';
import { repoRoot } from './lib/run';

const SCRIPT = 'test-slow';

/** The committed per-file weights the shard writer produces; only `files` (path → ms) is read. */
export const TEST_WEIGHTS_FILE = WEIGHTS_FILE;

/**
 * 20 s: the test-shards header measured the slowest file at 20.5 s when no file set the wall
 * (2026-08-27); CI run 43903381662 (2026-11-16) weighs 7 of 4,224 files above it, the slowest at
 * 41 s, against unit shards of 238–415 s. Above it one file is a visible share of a shard.
 */
export const SLOW_TEST_BUDGET_MS = 20_000;

/** Under this a stated reason is stale; the gap to the budget keeps run-to-run noise from flapping. */
const STALE_BELOW_MS = SLOW_TEST_BUDGET_MS / 2;

/** The one spelling: `// slow: ` and a reason of ten characters or more. */
const SLOW_REASON = /^\/\/\s*slow:\s*(\S.{9,})$/;

export interface SlowReason {
  readonly line: number;
  readonly reason: string;
}

/** The header comment: the leading run of `//` lines, a shebang and blanks, before any statement. */
function headerOf(source: string): readonly string[] {
  const lines = source.split('\n');
  const end = lines.findIndex((line) => {
    const text = line.trim();
    return text !== '' && !text.startsWith('//') && !text.startsWith('#!');
  });
  return end < 0 ? lines : lines.slice(0, end);
}

/** The stated reason in the header comment, or `undefined`: a marker below it is not read. */
export function slowReasonOf(source: string): SlowReason | undefined {
  const header = headerOf(source);
  for (const [index, line] of header.entries()) {
    const match = SLOW_REASON.exec(line.trim());
    if (match !== null) return { line: index + 1, reason: (match[1] ?? '').trim() };
  }
  return undefined;
}

/** Where a reason goes: the line after the header comment's last line, or line 1. */
function reasonLine(source: string): number {
  const header = headerOf(source);
  let last = 0;
  for (const [index, line] of header.entries()) if (line.trim() !== '') last = index + 1;
  return last + 1;
}

export type WeightsRead =
  | { readonly kind: 'read'; readonly files: ReadonlyMap<string, number> }
  | { readonly kind: 'unread'; readonly problem: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The weights document, checked: every entry a finite, non-negative millisecond count. */
export function parseWeights(value: unknown): WeightsRead {
  const raw = isRecord(value) ? value['files'] : undefined;
  if (!isRecord(raw)) {
    return { kind: 'unread', problem: 'it is not an object with a "files" object' };
  }
  const files = new Map<string, number>();
  for (const [path, ms] of Object.entries(raw)) {
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) {
      return { kind: 'unread', problem: `"files" holds ${path}, which is not a millisecond count` };
    }
    files.set(path, ms);
  }
  if (files.size === 0) return { kind: 'unread', problem: 'its "files" object is empty' };
  return { kind: 'read', files };
}

export interface SlowFile {
  readonly path: string;
  readonly ms: number;
  readonly reason?: string;
}

export interface SlowReport {
  readonly findings: readonly Finding[];
  /** Every file over the budget, its weight, and the reason it states when it states one. */
  readonly over: readonly SlowFile[];
  /** Weighted paths the tree no longer holds: the writer drops them on its next measurement. */
  readonly staleWeights: readonly string[];
}

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;

const unstatedFinding = (path: string, ms: number, line: number): Finding => ({
  code: 'X_TEST_SLOW_UNSTATED',
  cause: `${path} measured ${seconds(ms)} in ${TEST_WEIGHTS_FILE}, over the ${seconds(SLOW_TEST_BUDGET_MS)} budget, and its header states no reason — one file past its share of a shard sets CI's wall time alone`,
  fix: `edit ${path}:${String(line)} — add "// slow: <why the time is the work the assertion needs>" to the header comment; or split the file per shape, or stub the work no assertion reads, until it measures under ${seconds(SLOW_TEST_BUDGET_MS)}`,
  at: `${path}:${String(line)}`,
});

const staleFinding = (path: string, ms: number, line: number): Finding => ({
  code: 'X_TEST_SLOW_REASON_STALE',
  cause: `${path} states a slow: reason and measured ${seconds(ms)} in ${TEST_WEIGHTS_FILE}, under half the ${seconds(SLOW_TEST_BUDGET_MS)} budget — a reason it no longer needs would let it grow back unseen`,
  fix: `edit ${path}:${String(line)} — delete the "// slow:" line`,
  at: `${path}:${String(line)}`,
});

const unscannedFinding = (problem: string): Finding => ({
  code: 'X_TEST_SLOW_UNSCANNED',
  cause: `${TEST_WEIGHTS_FILE} read no weight — ${problem} — so no test file was held to the ${seconds(SLOW_TEST_BUDGET_MS)} budget, and that reads exactly like a tree where none is slow`,
  fix: "gh run download <run-id> -p 'verify-part-unit-*' -p 'test-timings-*' -D .x/ci-run/<run-id> && bun run scripts/test-weights.ts .x/ci-run/<run-id>   # <run-id>: a green run on main",
  at: TEST_WEIGHTS_FILE,
});

/**
 * The rule over the weights and the sources the tree holds (`path` → text). Pure: the root half
 * below does the reading.
 */
export function checkSlowTests(
  weights: WeightsRead,
  sources: ReadonlyMap<string, string>,
): SlowReport {
  if (weights.kind === 'unread') {
    return { findings: [unscannedFinding(weights.problem)], over: [], staleWeights: [] };
  }
  const findings: Finding[] = [];
  const over: SlowFile[] = [];
  const staleWeights: string[] = [];
  for (const [path, ms] of [...weights.files].sort(([a], [b]) => a.localeCompare(b))) {
    const source = sources.get(path);
    if (source === undefined) {
      staleWeights.push(path);
      continue;
    }
    if (ms <= SLOW_TEST_BUDGET_MS) continue;
    const reason = slowReasonOf(source);
    over.push(reason === undefined ? { path, ms } : { path, ms, reason: reason.reason });
    if (reason === undefined) findings.push(unstatedFinding(path, ms, reasonLine(source)));
  }
  for (const [path, source] of [...sources].sort(([a], [b]) => a.localeCompare(b))) {
    const ms = weights.files.get(path);
    if (ms === undefined || ms >= STALE_BELOW_MS) continue;
    const reason = slowReasonOf(source);
    if (reason !== undefined) findings.push(staleFinding(path, ms, reason.line));
  }
  return { findings, over, staleWeights };
}

/** The weights file at `root`, read: missing or not JSON is `unread`, never an empty map. */
async function readWeights(root: string): Promise<WeightsRead> {
  const file = Bun.file(`${root}/${TEST_WEIGHTS_FILE}`);
  if (!(await file.exists())) return { kind: 'unread', problem: 'the file does not exist' };
  let value: unknown;
  try {
    value = JSON.parse(await file.text());
  } catch {
    return { kind: 'unread', problem: 'the file is not JSON' };
  }
  return parseWeights(value);
}

/**
 * Every test source the corpus reads — before the weights, so an unreadable tree is
 * `X_CORPUS_UNSCANNED` — plus every weighted path outside its globs (`.claude/hooks/`) the tree
 * still holds.
 */
export async function slowTestReport(root: string): Promise<SlowReport> {
  const sources = new Map(
    (await corpus(root, 'tests')).map((file) => [file.path, file.source] as const),
  );
  const weights = await readWeights(root);
  if (weights.kind === 'read') {
    for (const path of weights.files.keys()) {
      if (sources.has(path)) continue;
      const file = Bun.file(`${root}/${path}`);
      if (await file.exists()) sources.set(path, await file.text());
    }
  }
  return checkSlowTests(weights, sources);
}

/** What this rule contributes to `x verify`'s `errors` step. */
export const slowTestFindings = async (root: string): Promise<readonly Finding[]> =>
  (await slowTestReport(root)).findings;

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const result = await slowTestReport(repoRoot());
  const stated = result.over.filter((file) => file.reason !== undefined).length;
  report(
    {
      ok: result.findings.length === 0,
      script: SCRIPT,
      summary:
        result.findings[0]?.code === 'X_TEST_SLOW_UNSCANNED'
          ? `${TEST_WEIGHTS_FILE} read no weight, so no test file was held to the budget`
          : result.findings.length === 0
            ? `every test file over ${seconds(SLOW_TEST_BUDGET_MS)} states why (${String(stated)} of ${String(result.over.length)})`
            : `${String(result.findings.length)} test file(s) break the slow-test rule`,
      findings: result.findings,
      data: { budgetMs: SLOW_TEST_BUDGET_MS, over: result.over, staleWeights: result.staleWeights },
    },
    args.json,
  );
}
