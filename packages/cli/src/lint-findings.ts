// `biome check --reporter=json` read as findings: one per diagnostic an edit fixes, and ONE for every
// diagnostic `--write` repairs, naming all their files in a single command. `X_LINT_FAILED` alone
// said `bunx biome check --write .`, which exits "Skipped 1 suggested fixes", still red; a finding
// per formatted file was twenty commands for one keystroke's worth of work (plan 101 19b, Y1).

import { ERROR_DOCS_URL } from '@ultimat3/core';
import { commentSafe } from './comment-safe';
import type { ExecResult } from './exec';
import { execOutput } from './exec';
import type { Finding } from './output';
import { quoteArg } from './shell-quote';
import type { StepOutcome } from './verify-step';

export const LINT_ARGV = [
  'bunx',
  'biome',
  'check',
  '--reporter=json',
  '--max-diagnostics=none',
  '.',
] as const;

interface Diagnostic {
  readonly category: string;
  readonly message: string;
  readonly path: string;
  readonly line: number;
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null;

/** Only what fails the step. `info` and `warning` exit 0, so they cannot be why it is red. */
const diagnosticFrom = (value: unknown): Diagnostic | undefined => {
  if (!isRecord(value) || !isRecord(value['location'])) return undefined;
  const { severity, category, message, location } = value as {
    severity?: unknown;
    category?: unknown;
    message?: unknown;
    location: Readonly<Record<string, unknown>>;
  };
  if (severity !== 'error' && severity !== 'fatal') return undefined;
  const { path, start } = location;
  if (typeof category !== 'string' || typeof path !== 'string') return undefined;
  const line = isRecord(start) && typeof start['line'] === 'number' ? start['line'] : 0;
  return { category, message: typeof message === 'string' ? message : category, path, line };
};

/**
 * The only categories `--write` always repairs. Biome's JSON does not say which lint rules carry a
 * safe fix, and telling a rule whose fix is "unsafe" to run `--write` is the no-op this replaced, so
 * a lint rule is an edit: true for all of them, and for the safe ones a little more work.
 */
const REPAIRED_BY_WRITE = (category: string): boolean =>
  category === 'format' || category.startsWith('assist/');

const placeOf = ({ path, line }: Diagnostic): string =>
  line > 0 ? `${path}:${String(line)}` : path;

/** A diagnostic only an edit fixes: the file, the rule and the message, one finding each. */
const editFinding = (diagnostic: Diagnostic): Finding => {
  const { category, message, path } = diagnostic;
  const place = placeOf(diagnostic);
  return {
    code: 'X_LINT_FAILED',
    cause: `${place} ${category}: ${message}`,
    fix: `bunx biome check ${quoteArg(path)}   # ${category}: edit ${commentSafe(place)}, ${commentSafe(message)}`,
    docs: ERROR_DOCS_URL,
    at: path,
  };
};

/** Every diagnostic `--write` repairs, as one finding whose one command names each file once. */
const writeFinding = (diagnostics: readonly Diagnostic[]): Finding => {
  const paths = [...new Set(diagnostics.map((diagnostic) => diagnostic.path))];
  const places = diagnostics.map((d) => `${placeOf(d)} ${d.category}: ${d.message}`);
  return {
    code: 'X_LINT_FAILED',
    cause: places.join('; '),
    // Each path through `quoteArg`, joined after: one command, every file one argument.
    fix: ['bunx biome check --write', ...paths.map(quoteArg)].join(' '),
    docs: ERROR_DOCS_URL,
    ...(paths.length === 1 ? { at: paths[0] } : {}),
  };
};

/** Every failing diagnostic, or `undefined` when the output is not the report it should be. */
export function lintFindings(stdout: string): readonly Finding[] | undefined {
  let report: unknown;
  try {
    report = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (!isRecord(report) || !Array.isArray(report['diagnostics'])) return undefined;
  const diagnostics = report['diagnostics'].flatMap((value) => {
    const diagnostic = diagnosticFrom(value);
    return diagnostic === undefined ? [] : [diagnostic];
  });
  const written = diagnostics.filter((d) => REPAIRED_BY_WRITE(d.category));
  // The command first: it clears its share in one run, and the edits are what is left after it.
  return [
    ...(written.length === 0 ? [] : [writeFinding(written)]),
    ...diagnostics.filter((d) => !REPAIRED_BY_WRITE(d.category)).map(editFinding),
  ];
}

/**
 * A red exit with no diagnostic to read (a config biome refused, a binary that would not start) stays
 * one finding pointing at the command, whose own output says what happened.
 */
export function lintOutcome(result: ExecResult): StepOutcome {
  if (result.ok) return { ok: true, findings: [] };
  const findings = lintFindings(result.stdout);
  if (findings !== undefined && findings.length > 0) return { ok: false, findings };
  return {
    ok: false,
    findings: [
      {
        code: 'X_LINT_FAILED',
        cause: 'biome exited red and reported no diagnostic to read',
        fix: 'bunx biome check .',
        docs: ERROR_DOCS_URL,
      },
    ],
    output: execOutput(result),
  };
}
