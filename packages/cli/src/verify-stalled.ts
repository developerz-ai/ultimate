// What a step was doing when its deadline passed, as the `X_VERIFY_STEP_TIMEOUT` finding. A hung
// test file used to cost eight minutes and report "2 process(es) were killed" — nothing a reader
// could run. The finding now names the file `bun test` had not finished, and its `fix:` runs it.

import { ERROR_DOCS_URL } from '@ultimat3/core';
import type { Finding } from './output';
import { quoteArg } from './shell-quote';
import type { InFlightRun, StepExpiry } from './verify-deadline';
import { QUIET_REPORTER_ENV, STEP_TIMEOUT_FIELD } from './verify-deadline';
import type { VerifyStepName } from './verify-step';

/** One `bun test` the step was waiting on, read against what it had printed. */
export interface StalledRun {
  /** The argv without its file list: `bun test --parallel=3`. */
  readonly command: string;
  /** Files the run was handed; 0 for a serial run, which selects by filter. */
  readonly files: number;
  /** `--parallel`'s width, and 1 for a serial run. */
  readonly workers: number;
  /** The files that had not finished, in argv order. */
  readonly unreported: readonly string[];
  /**
   * Whether `unreported` IS the stuck set: no more files than the workers can hold in flight.
   * More than that is a quiet reporter or a run that was slow rather than stuck.
   */
  readonly named: boolean;
}

/**
 * `X_VERIFY_STEP_TIMEOUT`'s `meta`. A `type`, not an interface: it has to stay assignable to
 * `Finding.meta`'s JSON record, which an interface (no implicit index signature) is not.
 */
export type StepTimeoutMeta = {
  readonly step: string;
  readonly deadlineMs: number;
  readonly killed: readonly { readonly pid: number; readonly command: string }[];
  readonly inFlight: readonly {
    readonly command: string;
    readonly files: number;
    readonly workers: number;
    readonly unreported: readonly string[];
    readonly named: boolean;
  }[];
};

/** Bun's per-file line: the path as it was handed, then a colon, alone on the line. */
const FILE_LINE = /^(\S.*\.test\.[cm]?[jt]sx?):$/;

const PARALLEL = '--parallel=';

const bare = (path: string): string => (path.startsWith('./') ? path.slice(2) : path);

/**
 * `bun test --parallel=N <files>` prints a file's line when the file FINISHES, so the stuck files
 * are the ones handed in and never printed. A serial `bun test` prints it when the file STARTS, so
 * the stuck file is the last one printed — unless a `(fail)` follows it, which is also all a quiet
 * reporter ever prints, and then nothing is claimed.
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
    const unreported = started === undefined || failed ? [] : [started];
    return { command, files: 0, workers: 1, unreported, named: unreported.length > 0 };
  }
  const reported = new Set(
    lines.flatMap((line) => {
      const path = FILE_LINE.exec(line)?.[1];
      return path === undefined ? [] : [bare(path)];
    }),
  );
  const files = rest.filter((arg) => !arg.startsWith('--'));
  const unreported = files.filter((file) => !reported.has(bare(file)));
  const workers = Math.max(1, Number(width.slice(PARALLEL.length)) || 1);
  return {
    command,
    files: files.length,
    workers,
    unreported,
    named: unreported.length > 0 && unreported.length <= workers,
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
  const named = runs.filter((run) => run.named);
  if (named.length > 0) {
    const files = named.flatMap((run) => run.unreported);
    const shown = files.slice(0, NAMED_IN_CAUSE).join(', ');
    const more = files.length > NAMED_IN_CAUSE ? `, +${String(files.length - NAMED_IN_CAUSE)}` : '';
    return `; still running when it was stopped: ${shown}${more} (${named[0]?.command ?? ''})`;
  }
  const open = runs.find((run) => run.unreported.length > 0);
  if (open !== undefined) {
    return `; ${String(open.unreported.length)} of the ${String(open.files)} file(s) of its running "${open.command}" had not reported — more than its ${String(open.workers)} worker(s) hold in flight, so the stuck one cannot be told apart${
      expiry.quietReporter
        ? ` (bun prints no line for a passing file while ${QUIET_REPORTER_ENV.join(', ')} is set)`
        : ''
    }`;
  }
  const waiting = expiry.inFlight[0];
  if (waiting === undefined) return '';
  return runs.length > 0
    ? `; every file of its running "${runs[0]?.command ?? ''}" had reported, so the run itself did not exit`
    : `; it was waiting on: ${waiting.command.slice(0, 4).join(' ')}`;
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
  const stuck = runs.filter((run) => run.named).flatMap((run) => run.unreported);
  const rerun = `${command} --only ${step} --json`;
  const longer = `if it legitimately needs longer, edit x.verify.json — add "${STEP_TIMEOUT_FIELD}": { "${step}": <milliseconds> }`;
  const unnamed = runs.some((run) => run.unreported.length > 0) && expiry.quietReporter;
  // Each path through `quoteArg`, one argv word apiece: a test file's name is data from the disk,
  // and this line is pasted into a shell.
  const alone = ['bun', 'test', ...stuck.map(quoteArg)].join(' ');
  const fix =
    stuck.length > 0
      ? `${alone}   # what had not finished, alone; the whole step: ${rerun}; ${longer}`
      : unnamed
        ? `env ${QUIET_REPORTER_ENV.map((name) => `-u ${name}`).join(' ')} ${rerun}   # bun's per-file lines back on, so the next timeout names the file; ${longer}`
        : `${rerun}   # reproduce it alone; ${longer}`;
  const meta: StepTimeoutMeta = {
    step,
    deadlineMs: ms,
    killed: expiry.killed.map((one) => ({ pid: one.pid, command: one.command })),
    inFlight: runs.map((run) => ({
      command: run.command,
      files: run.files,
      workers: run.workers,
      unreported: run.unreported,
      named: run.named,
    })),
  };
  return {
    code: 'X_VERIFY_STEP_TIMEOUT',
    cause: `step "${step}" did not finish within its ${String(ms)} ms deadline, so it was stopped and ${String(expiry.killed.length)} process(es) it had started were killed${inFlightClause(runs, expiry)}`,
    fix,
    docs: ERROR_DOCS_URL,
    ...(stuck[0] === undefined ? {} : { at: stuck[0] }),
    meta,
  };
};
