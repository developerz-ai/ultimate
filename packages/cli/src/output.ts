// One data shape, two renderers. Every command returns a `CommandResult`; the human renderer
// and the JSON renderer are projections of it, so `--json` can never drift from the terminal
// output (axiom 4). The human renderer owns the canonical 3-line error format.

import { renderThrowable, singleLine, stringField } from '@ultimat3/core';
import { msg } from './messages';

export interface Finding {
  readonly code: string;
  readonly cause: string;
  readonly fix: string;
  readonly docs?: string;
  /** Optional locator: a file, route, or table the finding is about. */
  readonly at?: string;
}

export interface StepResult {
  readonly name: string;
  readonly ok: boolean;
  readonly durationMs: number;
  readonly skipped?: boolean;
  readonly findings: readonly Finding[];
  /** Captured stdout/stderr, shown on failure or with --verbose. */
  readonly output?: string;
  /** Worker processes the step used; `1` means it ran serially. Absent for a non-test step. */
  readonly workers?: number;
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
   * 13 tools` line printed after the loop exits is a malformed frame to whatever is reading.
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
    docs: 'https://ultimate.dev/errors/X_CLI_UNEXPECTED',
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
  return `  ${step.workers === 1 ? msg('cli.verify.serial') : msg('cli.verify.workers', { workers: step.workers })}`;
};

export function renderHuman(result: CommandResult, verbose = false): string {
  const out: string[] = [];
  for (const step of result.steps ?? []) {
    out.push(`  ${mark(step)} ${step.name.padEnd(18)} ${step.durationMs}ms${width(step)}`);
    for (const finding of step.findings) out.push(renderFinding(finding, '      '));
    // NOT escaped, and that is the one exception: `output` is this process's own captured
    // subprocess stdout — `bun test`'s colour is the reason a human reads it at all, and it is
    // already split on its real newlines rather than carrying them inside one entry.
    if (step.output !== undefined && step.output.length > 0 && (verbose || !step.ok)) {
      for (const line of step.output.trimEnd().split('\n')) out.push(`      | ${line}`);
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

export function renderJson(result: CommandResult): string {
  const steps = (result.steps ?? []).map((step) => ({
    name: step.name,
    ok: step.ok,
    durationMs: step.durationMs,
    skipped: step.skipped === true,
    findings: step.findings,
    ...(step.workers === undefined ? {} : { workers: step.workers }),
    // A FAILED step carries its captured stdout, exactly as the human renderer prints it. CI runs
    // `--json`, and without this the log said only "one or more unit tests failed" with a generic
    // fix line — the failing test's name and its assertion diff existed and were thrown away, so
    // the only way to learn what broke was to re-run it somewhere else. CI output is a prompt:
    // whoever reads it next, agent or human, must be able to act without reproducing first.
    // Success stays quiet (`--verbose` is the human's opt-in) so a green run is not a wall of text.
    ...(step.ok || step.output === undefined || step.output.length === 0
      ? {}
      : { output: step.output }),
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
  return json ? renderJson(result) : renderHuman(result, verbose);
}

export function exitCodeFor(result: CommandResult): number {
  if (result.exitCode !== undefined) return result.exitCode;
  return result.ok ? 0 : 1;
}
