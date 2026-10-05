// One data shape, two renderers. Every command returns a `CommandResult`; the human renderer
// and the JSON renderer are projections of it, so `--json` can never drift from the terminal
// output (axiom 4). The human renderer owns the canonical 3-line error format.

import { ERROR_DOCS_URL, renderThrowable, singleLine, stringField } from '@ultimat3/core';
import { msg } from './messages';
import type { TestCounts } from './test-counts';

/** One shard's share of one step's corpus — what `x verify merge` checks the parts against. */
export interface ShardFacts {
  readonly index: number;
  readonly total: number;
  /** sha256 of the step's WHOLE sorted file list: every shard of one split carries the same one. */
  readonly corpusHash: string;
  /** The files this shard ran. */
  readonly files: readonly string[];
}

export interface Finding {
  readonly code: string;
  readonly cause: string;
  readonly fix: string;
  readonly docs?: string;
  /** Optional locator: a file, route, or table the finding is about. */
  readonly at?: string;
  /**
   * Where the finding's TEXT came from, when not from this process. `'ci-log'` is `x ci` reading
   * a finding back out of a CI log that anyone who can push a branch writes: its `fix` is fenced
   * and must never be run as this CLI's own instruction.
   */
  readonly source?: 'ci-log';
  /**
   * Structured facts behind `cause`, for a `--json` reader that would otherwise parse the sentence:
   * `X_VERIFY_STEP_TIMEOUT` carries the processes it killed and the files still in flight. Never
   * the only home of a fact — the human render prints `cause` and `fix`, and both already say it.
   */
  readonly meta?: { readonly [key: string]: JsonValue };
}

export interface StepResult {
  readonly name: string;
  readonly ok: boolean;
  readonly durationMs: number;
  readonly skipped?: boolean;
  readonly findings: readonly Finding[];
  /**
   * Captured stdout/stderr, for a reader working out what a step DID — carried by both renderers
   * on failure or with `--verbose`, and by neither on a quiet green run. Never the home of a fact:
   * a number a passing step must report by default goes in `CommandResult.data` (the `unit` step's
   * coverage is `data.coverage.unit`), where `--json` and the terminal both always have it.
   */
  readonly output?: string;
  /**
   * Advice that does not fail the step — a file inside `filesize`'s band below the ceiling. Unlike
   * `output`, carried by both renderers on a PASS too: advice a green run hides reaches nobody
   * until it has become the failure it warns about. One line of text per warning.
   */
  readonly warnings?: readonly string[];
  /** Worker processes the step used; `1` means it ran serially. Absent for a non-test step. */
  readonly workers?: number;
  /** Why the width is what it is — `4 workers (budget 4.0 GB)`. */
  readonly widthReason?: string;
  /** Under `x verify --shard`: this step's slice of its corpus. */
  readonly shard?: ShardFacts;
  /**
   * What the step's suite executed. Absent for a step that spawned no test process, which is NOT
   * the same state as `{ ran: 0 }` — a step with no suite and a suite whose every test skipped
   * itself both report `skipped`, and this is the only thing that tells a reader which one it is
   * looking at (#434).
   */
  readonly tests?: TestCounts;
}

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export interface CommandResult {
  readonly ok: boolean;
  readonly command: string;
  /** One line, already localized through `msg()`. */
  readonly summary: string;
  readonly steps?: readonly StepResult[];
  readonly findings?: readonly Finding[];
  readonly data?: JsonValue;
  /** Extra human-only lines (tables, file lists). Never carries data JSON does not have. */
  readonly lines?: readonly string[];
  readonly exitCode?: number;
  /**
   * A long-running command's "still running" handle: `dispatch` renders the result — the command
   * has already reported that it is up — and then awaits this before the process exits. Neither
   * renderer carries it, because it is behaviour rather than a fact, and a fact only one of them
   * could show is how the two drift.
   */
  readonly hold?: () => Promise<void>;
  /**
   * Which fd this result is written to. `stdout` for every command, absent included — and
   * `stderr` for the one case where fd 1 is not the command's to write on: `x mcp serve
   * --transport stdio`, whose stdout carries JSON-RPC frames, and where the `✓ mcp stdio serving
   * 18 tools` line printed after the loop exits is a malformed frame to whatever is reading.
   *
   * Behaviour, not a fact, exactly like `hold` above — so NEITHER renderer carries it. It says
   * where a rendered line goes, and a payload that also claimed it would be a second answer to a
   * question `dispatch` has already answered by choosing the sink.
   */
  readonly stream?: 'stdout' | 'stderr';
}

export interface UltimateErrorShape {
  readonly code: string;
  readonly cause: string;
  readonly fix: string;
  readonly docs?: string;
  readonly message: string;
}

/**
 * Structural check, deliberately not `instanceof`: an error may cross a subprocess or worker
 * boundary and arrive as a plain object, and the renderer must still produce the fix line.
 *
 * Every field goes through core's `stringField`, because the value is a caught throwable and the
 * probe itself is a property read: a getter that throws, or a `Proxy` trapping `get`, raised HERE
 * — one line before the total renderer below, in the function whose whole job is deciding what the
 * terminal shows.
 */
export function isUltimateErrorShape(value: unknown): value is UltimateErrorShape {
  return (
    stringField(value, 'code')?.startsWith('X_') === true &&
    stringField(value, 'cause') !== undefined &&
    stringField(value, 'fix') !== undefined
  );
}

export function findingFrom(value: unknown): Finding {
  // Read once and carry the values, rather than narrowing and reading the same properties again:
  // a getter is a function, and nothing promises it answers the same way twice.
  const code = stringField(value, 'code');
  const cause = stringField(value, 'cause');
  const fix = stringField(value, 'fix');
  if (code?.startsWith('X_') === true && cause !== undefined && fix !== undefined) {
    const docs = stringField(value, 'docs');
    return docs === undefined ? { code, cause, fix } : { code, cause, fix, docs };
  }
  // This is the LAST renderer between a thrown value and the terminal: a hostile `toString`, a
  // throwing `message` getter or a trapped `instanceof` here loses the whole report, not one line
  // of it. `renderThrowable` is total on all three.
  return {
    code: 'X_CLI_UNEXPECTED',
    cause: renderThrowable(value),
    fix: 'x doctor --json',
    docs: ERROR_DOCS_URL,
  };
}

const summaryOf = (value: UltimateErrorShape): string =>
  value.message.length > 0 && value.message !== value.code ? value.message : '';

/**
 * The 3-line contract format. Identical bytes in the terminal, the browser overlay and CI logs:
 *
 * ```
 * X_DB_DRIFT: schema differs from migrations
 *   cause: table "posts" has column "publish_at" not present in any migration
 *   fix:   x db gen "add publish_at"
 * ```
 */
export function renderFinding(finding: Finding, indent = ''): string {
  // Every field through `singleLine`: this is the format's only renderer for the terminal and CI
  // logs, and a `cause` carrying a newline would print a line a reader takes for a real finding.
  const code = singleLine(finding.code);
  const head = finding.at === undefined ? code : `${code} (${singleLine(finding.at)})`;
  const lines = [
    `${indent}${head}`,
    `${indent}  cause: ${singleLine(finding.cause)}`,
    `${indent}  fix:   ${singleLine(finding.fix)}`,
  ];
  if (finding.docs !== undefined) lines.push(`${indent}  docs:  ${singleLine(finding.docs)}`);
  return lines.join('\n');
}

/** Same format, but titled with the error's own summary line when it has one. */
export function renderUltimateError(error: UltimateErrorShape, indent = ''): string {
  const summary = summaryOf(error);
  const head = summary === '' ? error.code : `${error.code}: ${summary}`;
  const docs = error.docs;
  const finding: Finding =
    docs === undefined
      ? { code: head, cause: error.cause, fix: error.fix }
      : { code: head, cause: error.cause, fix: error.fix, docs };
  return renderFinding(finding, indent);
}

const mark = (step: StepResult): string => {
  if (step.skipped === true) return '-';
  return step.ok ? '✓' : '✗';
};

/**
 * How the step was run, when that is a fact about the step rather than about the machine. A gate
 * that silently went parallel is a gate whose failures a reader would blame on flakiness, so a
 * serial step says so and a parallel one names its width.
 */
const width = (step: StepResult): string => {
  if (step.workers === undefined || step.skipped === true) return '';
  if (step.widthReason !== undefined) return `  ${singleLine(step.widthReason)}`;
  return `  ${step.workers === 1 ? msg('cli.verify.serial') : msg('cli.verify.workers', { workers: step.workers })}`;
};

/**
 * Why a step is a dash, when the step itself can say. `- roadmap` is "there is nothing here to
 * check"; a step that spawned a suite and executed none of it is a different state, which is what
 * issue #434 reported as a green check — so a step carrying counts always says which it is, in one
 * of the two shapes its counts can take. The reason each test skipped lives in that test's own
 * NAME — `bun test` prints only the counts — so the line points at the suite and `x test <type>`
 * is what prints the names.
 */
const why = (step: StepResult): string => {
  const tests = step.tests;
  if (step.skipped !== true || tests === undefined) return '';
  if (tests.skipped === 0) return `  ${msg('cli.verify.ranNothing')}`;
  return `  ${msg('cli.verify.allSkipped', { skipped: tests.skipped })}`;
};

/** The one rule for a step's captured output, so the two renderers cannot answer differently. */
const showsOutput = (step: StepResult, verbose: boolean): boolean =>
  step.output !== undefined && step.output.length > 0 && (verbose || !step.ok);

export function renderHuman(result: CommandResult, verbose = false): string {
  const out: string[] = [];
  for (const step of result.steps ?? []) {
    out.push(
      `  ${mark(step)} ${step.name.padEnd(18)} ${step.durationMs}ms${width(step)}${why(step)}`,
    );
    for (const finding of step.findings) out.push(renderFinding(finding, '      '));
    // Escaped like every other line text reaches fd 1 through: a warning names a file path. A
    // green terminal run shows the count, not the list: `filesize`'s band alone is ~150 lines,
    // and a wall of advice on every run is read by nobody. `--json` always carries the list.
    const warnings = step.warnings ?? [];
    if (verbose) for (const warning of warnings) out.push(`      ! ${singleLine(warning)}`);
    else if (warnings.length > 0) {
      out.push(`      ! ${msg('cli.verify.warnings', { count: warnings.length })}`);
    }
    // NOT escaped, and that is the one exception: `output` is this process's own captured
    // subprocess stdout — `bun test`'s colour is the reason a human reads it at all, and it is
    // already split on its real newlines rather than carrying them inside one entry.
    if (showsOutput(step, verbose)) {
      for (const line of (step.output ?? '').trimEnd().split('\n')) out.push(`      | ${line}`);
    }
  }
  // Every free-text line through the SAME `singleLine` the 3-line format runs, because this is
  // where text the CLI did not write reaches fd 1: a GitHub review body (`x pr`), a CI log tail
  // (`x ci`), a page's own console (`x shot`). It was emitted verbatim, so an ESC byte in a PR
  // comment retitled the window and cleared the screen, and a newline in one entry printed a
  // second line a reader — or the agent this command exists for — takes for the renderer's own.
  for (const line of result.lines ?? []) out.push(singleLine(line));
  for (const finding of result.findings ?? []) out.push(renderFinding(finding, '  '));
  // The summary is foreign too: `cli.shot.threw` interpolates a page's own error message.
  out.push(`${result.ok ? '✓' : '✗'} ${singleLine(result.summary)}`);
  return out.join('\n');
}

export function renderJson(result: CommandResult, verbose = false): string {
  const steps = (result.steps ?? []).map((step) => ({
    name: step.name,
    ok: step.ok,
    durationMs: step.durationMs,
    skipped: step.skipped === true,
    findings: step.findings,
    // Never gated on `ok` or `--verbose`, unlike `output` below: see `StepResult.warnings`.
    ...(step.warnings === undefined || step.warnings.length === 0
      ? {}
      : { warnings: [...step.warnings] }),
    ...(step.workers === undefined ? {} : { workers: step.workers }),
    ...(step.widthReason === undefined ? {} : { widthReason: step.widthReason }),
    ...(step.shard === undefined
      ? {}
      : {
          shard: {
            index: step.shard.index,
            total: step.shard.total,
            corpusHash: step.shard.corpusHash,
            files: [...step.shard.files],
          },
        }),
    // The counts the human line's `why()` renders, as numbers: a `--json` reader deciding whether
    // a skipped lane is missing a suite or missing a prerequisite needs the same fact CI's log has.
    ...(step.tests === undefined ? {} : { tests: step.tests }),
    // A FAILED step carries its captured stdout, exactly as the human renderer prints it. CI runs
    // `--json`, and without this the log said only "one or more unit tests failed" with a generic
    // fix line — the failing test's name and its assertion diff existed and were thrown away, so
    // the only way to learn what broke was to re-run it somewhere else. CI output is a prompt:
    // whoever reads it next, agent or human, must be able to act without reproducing first.
    // Success stays quiet so a green run is not a wall of text — unless `--verbose` asked, which
    // is the same opt-in the terminal honours: a green step's output used to be reachable from the
    // human render and from nowhere under `--json`.
    ...(showsOutput(step, verbose) ? { output: step.output } : {}),
  }));
  const payload = {
    ok: result.ok,
    command: result.command,
    summary: result.summary,
    ...(result.steps === undefined ? {} : { steps }),
    ...(result.findings === undefined ? {} : { findings: result.findings }),
    ...(result.data === undefined ? {} : { data: result.data }),
  };
  return JSON.stringify(payload);
}

export function render(result: CommandResult, json: boolean, verbose = false): string {
  return json ? renderJson(result, verbose) : renderHuman(result, verbose);
}

export function exitCodeFor(result: CommandResult): number {
  if (result.exitCode !== undefined) return result.exitCode;
  return result.ok ? 0 : 1;
}
