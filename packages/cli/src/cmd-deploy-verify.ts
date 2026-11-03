// `x deploy verify`: does production serve this build, does it hold, and does a worker of this build
// claim every queue. HTTP and Postgres only (axiom 7): pods are SAMPLED through the load balancer,
// never enumerated, and a GitOps roll that never ran `x deploy` is checked the same way.

import type { Clock } from '@ultimat3/core';
import {
  BUILD_ID_HEADER,
  renderCauseValue,
  renderThrowable,
  systemClock,
  UltimateError,
} from '@ultimat3/core';
import { deadlineSignal } from '@ultimat3/core/outbound';
import type { QueueDemand, WorkerRecord } from '@ultimat3/jobs';
import { requireAppRoot } from './app-root';
import type { CommandContext } from './command';
import { failed, ok } from './command';
import type { WaitOutcome } from './deploy-verify-findings';
import {
  queueReadFinding,
  resultData,
  sampleFinding,
  unservedFinding,
} from './deploy-verify-findings';
import type { VerifyOptions } from './deploy-verify-flags';
import { readBuild, readOptions, VERIFY_COMMAND } from './deploy-verify-flags';
import type { QueueGrade } from './deploy-verify-grade';
import {
  emptyTally,
  failureOf,
  foldSample,
  gradeQueues,
  UNGRADED,
  windowClosed,
} from './deploy-verify-grade';
import { BadFlagError } from './errors';
import { msg } from './messages';
import type { CommandResult, Finding } from './output';

/** One sample's own limit: a pod that hangs is a bad sample, never the whole wait gone. */
const SAMPLE_TIMEOUT_MS = 10_000;
/**
 * The least a sample gets, however little of the wait is left. The last sleep ends ON the deadline,
 * and that sample cut to nothing tallied a healthy origin as `unreachable`, every run. So `--timeout`
 * can overrun by this much, once.
 */
const SAMPLE_FLOOR_MS = 1_000;

/** What the queue grade reads. `close` lets the short-lived pool go. */
export interface QueueReader {
  workers(): Promise<readonly WorkerRecord[]>;
  /**
   * `JobDriver.demand()`: running on a worker that still serves, plus due rows of unpaused queues.
   * Never `ready + running`, which counts a retiring old worker's runs and a paused queue's rows as
   * work an `--idle-ok` pool is missing.
   */
  demand(): Promise<readonly QueueDemand[]>;
  close(): Promise<void>;
}

export interface ExpectedQueues {
  readonly queues: readonly string[];
  /** A module that would not import leaves the set partial, which grades nothing honestly. */
  readonly findings: readonly Finding[];
}

export interface DeployVerifyDeps {
  readonly clock: Clock;
  sleep(ms: number): Promise<void>;
  expectedQueues(root: string): Promise<ExpectedQueues>;
  /**
   * `env` is the one `DATABASE_URL` came from, so the pooler mode is read from it too.
   * `statementTimeoutMs` is what is left of `--timeout`: the server cancels a read past it.
   */
  openQueue(
    databaseUrl: string,
    env: CommandContext['env'],
    statementTimeoutMs: number,
  ): Promise<QueueReader>;
  /**
   * Resolves once `ms` of real time pass: what a hung read is raced against. `signal` disarms it,
   * aborted the moment the read settles, so no timer holds the process open past the verdict.
   */
  expire(ms: number, signal: AbortSignal): Promise<void>;
}

/**
 * Resolves once `ms` of real time pass; `signal`'s abort disarms it. Core's `deadlineSignal`, the
 * one undoable deadline: a timer left armed would hold the process open past the verdict.
 */
export function expireAfter(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    const deadline = deadlineSignal(ms, signal);
    deadline.signal.addEventListener(
      'abort',
      () => {
        const fired = deadline.timedOut();
        deadline[Symbol.dispose]();
        if (fired) resolve();
      },
      { once: true },
    );
  });
}

/** Imported when asked: the verdict on the build alone never loads the app or a database driver. */
const realDeps: DeployVerifyDeps = {
  clock: systemClock,
  sleep: (ms) => Bun.sleep(ms),
  expectedQueues: async (root) => (await import('./deploy-verify-queues')).expectedQueues(root),
  openQueue: async (url, env, statementTimeoutMs) =>
    (await import('./deploy-verify-queues')).openQueue(url, env, statementTimeoutMs),
  expire: expireAfter,
};

interface Answered {
  readonly status: number | null;
  readonly build: string | null;
  readonly cached: boolean;
  readonly failure?: string;
}

/**
 * One `GET /readyz` on a connection of its own, so the load balancer chooses again: a kept-alive
 * socket would ask one pod the same question for the whole window. A redirect is an answer to tally,
 * never to follow: another host's `/readyz` says nothing about this origin.
 */
async function takeSample(origin: string, limitMs: number): Promise<Answered> {
  try {
    const response = await fetch(`${origin}/readyz`, {
      keepalive: false,
      redirect: 'manual',
      // Past a CDN or a caching proxy: the question is the fleet, never a stored copy of it.
      headers: { 'cache-control': 'no-cache', pragma: 'no-cache' },
      signal: AbortSignal.timeout(limitMs),
    });
    await response.body?.cancel();
    const header = response.headers.get(BUILD_ID_HEADER);
    const age = Number(response.headers.get('age') ?? '0');
    return {
      status: response.status,
      build: header === null || header === '' ? null : header,
      cached: Number.isNaN(age) || age > 0,
    };
  } catch (error) {
    return { status: null, build: null, cached: false, failure: renderThrowable(error) };
  }
}

/** The least time a database read gets, and the floor of its server-side `statement_timeout`. */
const READ_FLOOR_MS = 1_000;

/** The queue half: the set to grade, and how to reach the rows. Absent: no `DATABASE_URL`. */
interface QueuePlan {
  readonly expected: readonly string[];
  open(statementTimeoutMs: number): Promise<QueueReader>;
}

/** The last grade a read produced, and the last read that failed. No grade: none ever landed. */
interface QueueRead {
  readonly grade: QueueGrade | undefined;
  readonly lastFailure: string | undefined;
  /**
   * The grade came from a read on THIS pass. A kept grade is detail for the report and never a
   * pass: workers can go between a read that landed and the next that failed.
   */
  readonly current: boolean;
}

interface Verdict {
  readonly wait: WaitOutcome;
  /** `undefined`: no queue plan, or the window never closed so nothing was read. */
  readonly read: QueueRead | undefined;
}

/** One read of both halves, bounded by `limitMs` of real time. A miss is a failed read. */
async function readQueues(
  reader: QueueReader,
  input: {
    readonly expected: readonly string[];
    readonly build: string;
    readonly idleOk: readonly string[];
  },
  limitMs: number,
  deps: DeployVerifyDeps,
): Promise<QueueGrade> {
  const disarm = new AbortController();
  const expired = deps.expire(limitMs, disarm.signal).then(() => {
    throw new UltimateError({
      code: 'X_DB_UNAVAILABLE',
      cause: `a read of x_job_workers outlasted one --interval or what was left of --timeout (${limitMs} ms)`,
      fix: 'x jobs list --json',
    });
  });
  let rows: readonly [readonly WorkerRecord[], readonly QueueDemand[]];
  try {
    rows = await Promise.race([Promise.all([reader.workers(), reader.demand()]), expired]);
  } finally {
    disarm.abort();
  }
  const [workers, demand] = rows;
  return gradeQueues({
    ...input,
    workers,
    depth: new Map(demand.map((queue) => [queue.queue, queue.demand])),
  });
}

/**
 * Sample until the window holds AND, with a queue plan, every queue is served, both on the same
 * pass: web rolling back while the workers still roll is red, never a window that closed earlier.
 * The queues are read only once the window has closed, then on every pass; the web role and the
 * workers roll independently, so one read right after the window would fail a healthy roll. A failed
 * read keeps the last grade. `--timeout` ends the whole wait, reads included.
 */
async function awaitVerdict(
  options: VerifyOptions,
  build: string,
  deadline: number,
  deps: DeployVerifyDeps,
  plan: QueuePlan | undefined,
): Promise<Verdict> {
  // One bad sample per window's worth of samples is the most a settled fleet is allowed.
  const perWindow = Math.max(1, Math.ceil(options.windowMs / options.intervalMs));
  let tally = emptyTally();
  let lastFailure: string | undefined;
  let reader: QueueReader | undefined;
  let read: QueueRead | undefined;
  const left = (): number => deadline - deps.clock.monotonic();
  /** One `/readyz` sample, folded in; whether the window holds after it. */
  const sample = async (): Promise<boolean> => {
    const answered = await takeSample(
      options.origin,
      Math.max(SAMPLE_FLOOR_MS, Math.min(SAMPLE_TIMEOUT_MS, left())),
    );
    lastFailure = answered.failure ?? lastFailure;
    tally = foldSample(
      tally,
      {
        at: deps.clock.monotonic(),
        status: answered.status,
        build: answered.build,
        cached: answered.cached,
      },
      build,
    );
    return windowClosed(tally, options.windowMs, perWindow);
  };
  try {
    for (;;) {
      // Every pass starts with nothing current: a grade from an earlier pass is history.
      if (read !== undefined) read = { ...read, current: false };
      let closed = await sample();
      if (closed && plan !== undefined) {
        // One --interval at most: the window's last sample is never older than that when the
        // queues are judged, and the server stops the statement at the same bound.
        const bound = Math.max(READ_FLOOR_MS, Math.min(options.intervalMs, left()));
        reader ??= await plan.open(bound);
        try {
          const grade = await readQueues(
            reader,
            { expected: plan.expected, build, idleOk: options.idleOk },
            bound,
            deps,
          );
          read = { grade, lastFailure: read?.lastFailure, current: true };
        } catch (error) {
          // One reset connection is a read lost, never the verdict: the last grade stands.
          read = { grade: read?.grade, lastFailure: renderThrowable(error), current: false };
        }
        // Served is judged against web as it answers NOW: a sample taken after the read landed,
        // so a rollback during the read is red, never a green from the sample before it.
        if (read.current && read.grade?.unserved.length === 0) closed = await sample();
      }
      // The one success rule: this pass's sample holds the window and, with a plan, this pass's
      // read landed and serves every queue. Nothing kept from an earlier pass counts.
      const served =
        plan === undefined || (read?.current === true && read.grade?.unserved.length === 0);
      const wait = { tally, closed, lastFailure };
      if ((closed && served) || left() <= 0) return { wait, read };
      await deps.sleep(Math.min(options.intervalMs, left()));
    }
  } finally {
    await reader?.close();
  }
}

/** The set first, so a typo or an app that will not load costs no wait. */
async function readExpected(
  root: string,
  options: VerifyOptions,
  deps: DeployVerifyDeps,
): Promise<ExpectedQueues> {
  const expected = await deps.expectedQueues(root);
  if (expected.findings.length > 0) return expected;
  const stray = options.idleOk.find((queue) => !expected.queues.includes(queue));
  if (stray !== undefined) {
    throw new BadFlagError({
      flag: 'idle-ok',
      command: VERIFY_COMMAND,
      reason: `${renderCauseValue(stray)} is not a queue of this app (${expected.queues.map((queue) => renderCauseValue(queue)).join(', ')}), so it would exempt nothing`,
      fix: 'x jobs list --json   # data.depth.queues names what each queue holds',
    });
  }
  return expected;
}

export async function runDeployVerify(
  ctx: CommandContext,
  deps: DeployVerifyDeps = realDeps,
): Promise<CommandResult> {
  const root = requireAppRoot('deploy', ctx.cwd).dir;
  const options = readOptions(ctx);
  const build = await readBuild(ctx, root);
  // Read off the env directly: `resolveServices` falls back to the embedded database and would grade
  // an empty one, so a CI job with no credentials would "pass" having read nothing.
  const raw = ctx.env['DATABASE_URL'];
  const databaseUrl = raw === undefined || raw.trim() === '' ? undefined : raw;
  const expected = databaseUrl === undefined ? undefined : await readExpected(root, options, deps);
  if (expected !== undefined && expected.findings.length > 0) {
    return failed(
      'deploy',
      msg('cli.deploy.unverified', { build, count: expected.findings.length }),
      {
        findings: expected.findings,
      },
    );
  }

  const deadline = deps.clock.monotonic() + options.timeoutMs;
  const plan: QueuePlan | undefined =
    databaseUrl === undefined || expected === undefined
      ? undefined
      : {
          expected: expected.queues,
          open: (statementTimeoutMs) => deps.openQueue(databaseUrl, ctx.env, statementTimeoutMs),
        };
  const { wait, read } = await awaitVerdict(options, build, deadline, deps, plan);
  if (!wait.closed) {
    return failed('deploy', msg('cli.deploy.unverified', { build, count: 1 }), {
      findings: [sampleFinding(failureOf(wait.tally, build), wait, build, options)],
      data: resultData(build, options.windowMs, wait.tally, read?.grade ?? UNGRADED),
    });
  }

  const samples = wait.tally.total;
  const held = { build, windowMs: options.windowMs, samples };
  if (plan === undefined) {
    return ok('deploy', msg('cli.deploy.verifiedUngraded', held), {
      data: resultData(build, options.windowMs, wait.tally, UNGRADED),
    });
  }
  const queues = read?.grade;
  if (queues === undefined) {
    return failed('deploy', msg('cli.deploy.unverified', { build, count: 1 }), {
      findings: [queueReadFinding(read?.lastFailure)],
      data: resultData(build, options.windowMs, wait.tally, UNGRADED),
    });
  }
  const data = resultData(build, options.windowMs, wait.tally, queues);
  // A kept grade that says served is not a pass: the read that would confirm it never landed.
  if (queues.unserved.length === 0 && read?.current !== true) {
    return failed('deploy', msg('cli.deploy.unverified', { build, count: 1 }), {
      findings: [queueReadFinding(read?.lastFailure)],
      data,
    });
  }
  if (queues.unserved.length > 0) {
    return failed(
      'deploy',
      msg('cli.deploy.unverified', { build, count: queues.unserved.length }),
      {
        findings: queues.unserved.map((unserved) => unservedFinding(unserved, options.origin)),
        data,
      },
    );
  }
  const verified = { ...held, served: queues.served.length, idle: queues.idle.length };
  return ok('deploy', msg('cli.deploy.verified', verified), { data });
}
