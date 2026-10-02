// What a step was doing when its deadline passed, as the `X_VERIFY_STEP_TIMEOUT` finding. A hung
// test file used to cost eight minutes and report "2 process(es) were killed" — nothing a reader
// could run. The finding now names the file bun says a killed worker held, and its `fix:` runs it.

import { ERROR_DOCS_URL } from '@ultimat3/core';
import type { Finding } from './output';
import { quoteArg } from './shell-quote';
import type { InFlightRun, StepExpiry } from './verify-deadline';
import { STEP_TIMEOUT_FIELD } from './verify-deadline';
import type { VerifyStepName } from './verify-step';

/**
 * One `bun test` the step was waiting on, read against what it printed as it was stopped. A `type`,
 * like the meta that carries it: an interface is not assignable to `Finding.meta`'s JSON record.
 */
export type StalledRun = {
  /** The argv without its file list: `bun test --parallel=3`. */
  readonly command: string;
  /** Files the run was handed; 0 for a serial run, which selects by filter. */
  readonly files: number;
  /** `--parallel`'s width, and 1 for a serial run. */
  readonly workers: number;
  /** The files that were still running, as bun named them. Empty when it named none. */
  readonly stuck: readonly string[];
};

/** `X_VERIFY_STEP_TIMEOUT`'s `meta`. A `type`: an interface is not assignable to `Finding.meta`. */
export type StepTimeoutMeta = {
  readonly step: string;
  readonly deadlineMs: number;
  readonly killed: readonly { readonly pid: number; readonly command: string }[];
  readonly inFlight: readonly StalledRun[];
};

/**
 * What a `--parallel` coordinator prints for the file a killed worker was holding. The guard kills
 * the workers first for exactly this line (`verify-deadline.ts`); it is bun's own statement of
 * what was in flight, and it is printed in every reporter mode.
 */
const CRASHED = /^\s*✗ (.+) \(worker crashed: SIG[A-Z0-9]+\)$/;

/** Bun's per-file header — `::group::`-prefixed on GitHub Actions. A serial run prints it at START. */
const FILE_LINE = /^(?:::group::)?(\S.*\.test\.[cm]?[jt]sx?):$/;

const PARALLEL = '--parallel=';

const bare = (path: string): string => (path.startsWith('./') ? path.slice(2) : path);

/**
 * A parallel run names its stuck files itself, one crash line per killed worker. A serial run has
 * no worker to kill: it prints a file's header when the file STARTS, so the stuck file is the last
 * one printed — unless a `(fail)` follows it, which is also all a failures-only reporter ever
 * prints, and then nothing is claimed.
 */
export function stalledRun(run: InFlightRun): StalledRun | undefined {
  const [program, verb, ...rest] = run.command;
  if (program !== 'bun' || verb !== 'test' || run.output === undefined) return undefined;
  const lines = run.output.split('\n').map((line) => line.trimEnd());
  const width = rest.find((arg) => arg.startsWith(PARALLEL));
  const flags = rest.filter((arg) => arg.startsWith('--') && !arg.startsWith('--timings'));
  const command = ['bun', 'test', ...flags].join(' ');
  if (width === undefined) {
    const last = lines.findLastIndex((line) => FILE_LINE.test(line));
    const started = last < 0 ? undefined : FILE_LINE.exec(lines[last] ?? '')?.[1];
    const failed = lines.slice(last + 1).some((line) => line.startsWith('(fail)'));
    return {
      command,
      files: 0,
      workers: 1,
      stuck: started === undefined || failed ? [] : [started],
    };
  }
  const files = rest.filter((arg) => !arg.startsWith('--'));
  const crashed = lines.flatMap((line) => {
    const path = CRASHED.exec(line)?.[1];
    // As the caller handed it in, so the `fix:` reruns the very argument the run was given.
    return path === undefined ? [] : [files.find((file) => bare(file) === bare(path)) ?? path];
  });
  return {
    command,
    files: files.length,
    workers: Math.max(1, Number(width.slice(PARALLEL.length)) || 1),
    stuck: [...new Set(crashed)],
  };
}

/** How many paths a `cause:` spells out — the rest are in `meta`. */
const NAMED_IN_CAUSE = 5;

const OUTPUT_TAIL_CHARS = 4_000;

/** The last thing each killed run printed: what a reader of a red step looks at first. */
export function stalledOutput(expiry: StepExpiry): string | undefined {
  const text = expiry.inFlight
    .flatMap((run) => (run.output === undefined || run.output === '' ? [] : [run.output]))
    .join('\n');
  if (text === '') return undefined;
  return text.length > OUTPUT_TAIL_CHARS ? `…${text.slice(-OUTPUT_TAIL_CHARS)}` : text;
}

const inFlightClause = (runs: readonly StalledRun[], expiry: StepExpiry): string => {
  const files = runs.flatMap((run) => run.stuck);
  const named = runs.find((run) => run.stuck.length > 0);
  if (named !== undefined) {
    const shown = files.slice(0, NAMED_IN_CAUSE).join(', ');
    const more = files.length > NAMED_IN_CAUSE ? `, +${String(files.length - NAMED_IN_CAUSE)}` : '';
    return `; still running when it was stopped: ${shown}${more} (${named.command})`;
  }
  const waiting = expiry.inFlight[0];
  if (waiting === undefined) return '';
  return runs[0] === undefined
    ? `; it was waiting on: ${waiting.command.slice(0, 4).join(' ')}`
    : `; its running "${runs[0].command}" named no file still in flight, so the run itself did not exit`;
};

/**
 * A step that ran past its deadline, on that step's own line. `command` is the gate as it was
 * invoked here (`x verify`, or `bun run verify` at the framework root), so the fix runs where the
 * finding was raised. With a stuck file named, the fix runs THAT file; the step's own rerun and
 * the `stepTimeoutMs` edit ride behind it.
 */
export const stepTimeoutFinding = (
  step: VerifyStepName,
  ms: number,
  expiry: StepExpiry,
  command: string,
): Finding => {
  const runs = expiry.inFlight.flatMap((run) => stalledRun(run) ?? []);
  const stuck = runs.flatMap((run) => run.stuck);
  const rerun = `${command} --only ${step} --json`;
  const longer = `if it legitimately needs longer, edit x.verify.json — add "${STEP_TIMEOUT_FIELD}": { "${step}": <milliseconds> }`;
  // Each path through `quoteArg`, one argv word apiece: a test file's name is data from the disk,
  // and this line is pasted into a shell.
  const alone = ['bun', 'test', ...stuck.map(quoteArg)].join(' ');
  const meta: StepTimeoutMeta = {
    step,
    deadlineMs: ms,
    killed: expiry.killed.map((one) => ({ pid: one.pid, command: one.command })),
    inFlight: runs,
  };
  return {
    code: 'X_VERIFY_STEP_TIMEOUT',
    cause: `step "${step}" did not finish within its ${String(ms)} ms deadline, so it was stopped and ${String(expiry.killed.length)} process(es) it had started were killed${inFlightClause(runs, expiry)}`,
    fix:
      stuck.length > 0
        ? `${alone}   # what had not finished, alone; the whole step: ${rerun}; ${longer}`
        : `${rerun}   # reproduce it alone; ${longer}`,
    docs: ERROR_DOCS_URL,
    ...(stuck[0] === undefined ? {} : { at: stuck[0] }),
    meta,
  };
};
