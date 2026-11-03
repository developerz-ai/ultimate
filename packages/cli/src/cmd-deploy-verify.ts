// `x deploy verify`: does production serve this build, does it hold, and does a worker of this build
// claim every queue. HTTP and Postgres only (axiom 7): pods are SAMPLED through the load balancer,
// never enumerated, and a GitOps roll that never ran `x deploy` is checked the same way.

import type { Clock } from '@ultimat3/core';
import { BUILD_ID_HEADER, renderCauseValue, renderThrowable, systemClock } from '@ultimat3/core';
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
  /** `env` is the one `DATABASE_URL` came from, so the pooler mode is read from it too. */
  openQueue(databaseUrl: string, env: CommandContext['env']): Promise<QueueReader>;
}

/** Imported when asked: the verdict on the build alone never loads the app or a database driver. */
const realDeps: DeployVerifyDeps = {
  clock: systemClock,
  sleep: (ms) => Bun.sleep(ms),
  expectedQueues: async (root) => (await import('./deploy-verify-queues')).expectedQueues(root),
  openQueue: async (url, env) => (await import('./deploy-verify-queues')).openQueue(url, env),
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

/** Until `--window` of consecutive good samples, or `--timeout`, whichever is first. */
async function awaitWindow(
  options: VerifyOptions,
  build: string,
  deadline: number,
  deps: DeployVerifyDeps,
): Promise<WaitOutcome> {
  // One bad sample per window's worth of samples is the most a settled fleet is allowed.
  const perWindow = Math.max(1, Math.ceil(options.windowMs / options.intervalMs));
  let tally = emptyTally();
  let lastFailure: string | undefined;
  for (;;) {
    const left = deadline - deps.clock.monotonic();
    const answered = await takeSample(
      options.origin,
      Math.max(SAMPLE_FLOOR_MS, Math.min(SAMPLE_TIMEOUT_MS, left)),
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
    if (windowClosed(tally, options.windowMs, perWindow))
      return { tally, closed: true, lastFailure };
    const remaining = deadline - deps.clock.monotonic();
    if (remaining <= 0) return { tally, closed: false, lastFailure };
    await deps.sleep(Math.min(options.intervalMs, remaining));
  }
}

/**
 * Re-read until every queue is served or `--timeout` ends the wait. The web role and the workers
 * roll independently and a worker drains for as long as its jobs run, so one read right after the
 * window would fail a healthy roll that had a minute to go. Always reads at least once.
 */
async function awaitQueues(
  expected: readonly string[],
  options: VerifyOptions,
  build: string,
  deadline: number,
  reader: QueueReader,
  deps: DeployVerifyDeps,
): Promise<QueueRead> {
  let grade: QueueGrade | undefined;
  let lastFailure: string | undefined;
  for (;;) {
    // One reset connection is a sample lost, never the verdict: the last grade stands, and the
    // next interval reads again.
    try {
      const [workers, demand] = await Promise.all([reader.workers(), reader.demand()]);
      grade = gradeQueues({
        build,
        expected,
        workers,
        depth: new Map(demand.map((queue) => [queue.queue, queue.demand])),
        idleOk: options.idleOk,
      });
    } catch (error) {
      lastFailure = renderThrowable(error);
    }
    const remaining = deadline - deps.clock.monotonic();
    if ((grade !== undefined && grade.unserved.length === 0) || remaining <= 0) {
      return { grade, lastFailure };
    }
    await deps.sleep(Math.min(options.intervalMs, remaining));
  }
}

/** The last grade a read produced, and the last read that failed. No grade: none ever landed. */
interface QueueRead {
  readonly grade: QueueGrade | undefined;
  readonly lastFailure: string | undefined;
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
  const wait = await awaitWindow(options, build, deadline, deps);
  if (!wait.closed) {
    return failed('deploy', msg('cli.deploy.unverified', { build, count: 1 }), {
      findings: [sampleFinding(failureOf(wait.tally, build), wait, build, options)],
      data: resultData(build, options.windowMs, wait.tally, UNGRADED),
    });
  }

  const samples = wait.tally.total;
  const held = { build, windowMs: options.windowMs, samples };
  if (databaseUrl === undefined || expected === undefined) {
    return ok('deploy', msg('cli.deploy.verifiedUngraded', held), {
      data: resultData(build, options.windowMs, wait.tally, UNGRADED),
    });
  }
  const reader = await deps.openQueue(databaseUrl, ctx.env);
  let read: QueueRead;
  try {
    read = await awaitQueues(expected.queues, options, build, deadline, reader, deps);
  } finally {
    await reader.close();
  }
  const queues = read.grade;
  if (queues === undefined) {
    return failed('deploy', msg('cli.deploy.unverified', { build, count: 1 }), {
      findings: [queueReadFinding(read.lastFailure)],
      data: resultData(build, options.windowMs, wait.tally, UNGRADED),
    });
  }
  const data = resultData(build, options.windowMs, wait.tally, queues);
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
