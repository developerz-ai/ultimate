import { writeSync } from 'node:fs';

// Output for the root scripts. Same rule as the CLI: one data shape, two renderers, `--json` on
// every script — so the repo's own automation is as machine-readable as the framework it builds.

export interface Finding {
  readonly code: string;
  readonly cause: string;
  readonly fix: string;
  readonly at?: string;
}

export interface ScriptResult {
  readonly ok: boolean;
  readonly script: string;
  readonly summary: string;
  readonly findings?: readonly Finding[];
  readonly data?: unknown;
  readonly lines?: readonly string[];
}

/** The 3-line contract format, identical to the one @ultimat3/cli prints. */
export function renderFinding(finding: Finding, indent = '  '): string {
  const head = finding.at === undefined ? finding.code : `${finding.code} (${finding.at})`;
  return [
    `${indent}${head}`,
    `${indent}  cause: ${finding.cause}`,
    `${indent}  fix:   ${finding.fix}`,
  ].join('\n');
}

export function render(result: ScriptResult, json: boolean): string {
  if (json) {
    return JSON.stringify({
      ok: result.ok,
      script: result.script,
      summary: result.summary,
      findings: result.findings ?? [],
      ...(result.data === undefined ? {} : { data: result.data }),
    });
  }
  const lines = [...(result.lines ?? [])];
  for (const finding of result.findings ?? []) lines.push(renderFinding(finding));
  lines.push(`${result.ok ? '✓' : '✗'} ${result.summary}`);
  return lines.join('\n');
}

/**
 * Write to stdout and be certain it arrived, even if the next statement exits the process.
 *
 * `process.stdout.write()` is ASYNCHRONOUS whenever stdout is a pipe — which is what it is in CI
 * and under `| jq`. Anything past the 64KB pipe buffer is queued, and `process.exit()` discards the
 * queue, so the output silently truncates. Measured: a 100KB payload arrives as exactly 65536
 * bytes through a pipe, and complete on a terminal, where the same call is synchronous. A `--json`
 * contract that truncates under a pipe is a `--json` contract for nobody — the pipe is the only
 * reason it exists.
 *
 * `writeSync` on fd 1 rather than awaiting a drain callback, because that keeps `report()`
 * synchronous: making it async would mean ten call sites must remember `await`, and one that
 * forgets falls through to the end of the module and exits 0 with a failing result. A node: API,
 * and unavoidable — Bun has no synchronous stdout write of its own.
 *
 * The loop is not decoration: a single `writeSync` to a pipe may write fewer bytes than it was
 * given, and dropping the remainder would reintroduce the bug in a harder-to-see form.
 */
export function writeOut(text: string): void {
  const buffer = Buffer.from(text);
  let written = 0;
  while (written < buffer.length) {
    written += writeSync(1, buffer, written, buffer.length - written);
  }
}

/** Print and exit. Scripts call this exactly once, at the end. */
export function report(result: ScriptResult, json: boolean): never {
  writeOut(`${render(result, json)}\n`);
  process.exit(result.ok ? 0 : 1);
}
