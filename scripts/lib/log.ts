import { writeSync } from 'node:fs';
import { backoffDelay } from '../../packages/core/src/backoff';

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
 *
 * `EAGAIN` is a retry, never a failure. A CI runner hands the process a stdout that is a pipe in
 * NON-BLOCKING mode, and a `writeSync` to one whose buffer is full throws instead of blocking —
 * so the fix for the truncation crashed the whole gate on GitHub Actions, printing nothing at all
 * and leaving `x verify` looking like it had produced no output. The reader drains within
 * microseconds and the next attempt succeeds; treating "would block" as fatal is the bug.
 *
 * BOUNDED, though: a reader that never drains turned an unbounded retry into a script that never
 * exits, spinning a core. `OUT_EAGAIN_ATTEMPTS` stalls in a row, each waiting longer (capped), then
 * the text is dropped and counted (`droppedWrites()`) — the same rule as `@ultimat3/cli`'s
 * `writeAll`, kept as its own loop because that module imports the `@ultimat3/core` barrel, which
 * every script here would then evaluate at startup; the curve is core's `backoff.ts` leaf.
 */
export function writeOut(text: string): void {
  writeFully(Buffer.from(text));
}

/** Consecutive stalls one write may absorb before its text is dropped. Progress resets it. */
export const OUT_EAGAIN_ATTEMPTS = 50;

/** Core's one curve (the leaf, not the barrel), exponential and capped: 1, 2, 4 … 32 ms. */
const backoffMs = (stall: number): number => backoffDelay({ attempt: stall, base: 1, max: 32 });

/** `writeSync`'s shape on fd 1, so a test can hand in a pipe that is full forever. */
export type StdoutWrite = (
  fd: number,
  buffer: Uint8Array,
  offset: number,
  length: number,
) => number;

let dropped = 0;

/** Writes this process dropped to a reader that never drained. */
export const droppedWrites = (): number => dropped;

const isEagain = (cause: unknown): boolean =>
  typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === 'EAGAIN';

/** Every byte to fd 1, or none past `OUT_EAGAIN_ATTEMPTS` stalls in a row. True when it all arrived. */
export function writeFully(
  buffer: Uint8Array,
  write: StdoutWrite = writeSync,
  sleep: (ms: number) => void = Bun.sleepSync,
): boolean {
  let written = 0;
  let stalls = 0;
  while (written < buffer.length) {
    let progress = 0;
    try {
      progress = write(1, buffer, written, buffer.length - written);
    } catch (cause) {
      if (!isEagain(cause)) throw cause;
    }
    if (progress > 0) {
      written += progress;
      stalls = 0;
      continue;
    }
    stalls += 1;
    if (stalls >= OUT_EAGAIN_ATTEMPTS) {
      dropped += 1;
      return false;
    }
    sleep(backoffMs(stalls));
  }
  return true;
}

/** Print and exit. Scripts call this exactly once, at the end. */
export function report(result: ScriptResult, json: boolean): never {
  writeOut(`${render(result, json)}\n`);
  process.exit(result.ok ? 0 : 1);
}
