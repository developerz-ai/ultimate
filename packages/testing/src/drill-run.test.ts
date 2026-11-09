// One drill played on a stand-in fleet: a real loopback web role whose answers follow the faulted
// dependency, a recording proxy and a scripted role. Proves the sequence — fault phases in order,
// then pass, recovery measured, signal then respawn — and that the verdict reads what it measured.

import { afterEach, describe, expect, test } from 'bun:test';
import type { DrillFleet, DrillRoleProcess } from './drill-fleet';
import type { DrillSql } from './drill-jobs';
import { runDrill } from './drill-run';
import type { DrillRole, DrillService } from './drills';
import { drillNamed } from './drills';
import type { FaultMode, FaultProxy } from './fault-proxy';
import { allowHost, resetNetwork } from './sealed-network';

const servers: { stop(force?: boolean): unknown }[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
  resetNetwork();
});

const budgets = {
  deadlineMs: 5_000,
  promptMs: 1_000,
  recoveryMs: 4_000,
  readinessMs: 5_000,
  drainMs: 5_000,
  readiness: 'dependencies' as const,
  phaseMs: 10,
};

/** The load's default lane count, which every test below that does not name one plays with. */
const DEFAULT_LANES = 4;

/** `down` answers what the web role says while the dependency is faulted. */
function stage(
  down: () => Response,
  jobs = { ran: 2, stuck: 0, doubled: 0 },
  lanes = DEFAULT_LANES,
) {
  let mode: FaultMode = { kind: 'pass' };
  let downAnswers = 0;
  let upAnswers = 0;
  const waiters: (() => void)[] = [];
  const wake = (): void => {
    for (const waiter of waiters.splice(0)) waiter();
  };
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      const faulted = mode.kind !== 'pass';
      if (path === '/readyz') return new Response(null, { status: faulted ? 503 : 200 });
      if (!faulted) {
        upAnswers += 1;
        wake();
        return new Response('ok');
      }
      downAnswers += 1;
      wake();
      return down();
    },
  });
  servers.push(server);
  allowHost(`127.0.0.1:${String(server.port)}`);
  const base = `http://127.0.0.1:${String(server.port)}`;
  const modes: FaultMode[] = [];
  const proxy: FaultProxy = {
    port: 0,
    get mode() {
      return mode;
    },
    async set(next) {
      modes.push(next);
      mode = next;
    },
    counts: () => ({
      accepted: 0,
      reset: 0,
      upstreamFailed: 0,
      open: 0,
      bytesUp: 0,
      bytesDown: 0,
      held: 0,
    }),
    close: () => undefined,
  };
  const signals: string[] = [];
  const state = { respawns: 0 };
  const role = (name: DrillRole): DrillRoleProcess => ({
    role: name,
    origin: base,
    readyz: `${base}/readyz`,
    signal: (signal) => void signals.push(`${name}:${signal}`),
    exited: async () => 0,
    respawn: async () => {
      state.respawns += 1;
    },
    log: () => '',
  });
  const fleet: DrillFleet = {
    base,
    databaseUrl: 'postgres://unused',
    proxies: new Map<DrillService, FaultProxy>([['postgres', proxy]]),
    roles: new Map([
      ['web', role('web')],
      ['worker', role('worker')],
    ]),
    stop: async () => undefined,
  };
  const until = async (done: () => boolean): Promise<void> => {
    while (!done()) {
      await new Promise<void>((resolve) => {
        waiters.push(resolve);
      });
    }
  };
  // No wall clock. A fault phase lasts until the web role has answered three requests while down;
  // every other wait is one turn but recovery's. `recovers` reads a 2xx that STARTED after the
  // fault cleared, and up to one request per lane was already on the wire when it did: those
  // arrive as up answers too. So recovery waits for `lanes + 1` of them — at least one was sent
  // after the clear. Two was a race: with every lane in flight both could be early ones, and
  // the drill stopped on no recovery evidence (`recovers` red beside `requests-coded`).
  const sleep = async (ms: number): Promise<void> => {
    if (ms === budgets.phaseMs) {
      const target = downAnswers + 3;
      await until(() => downAnswers >= target);
    } else if (ms === budgets.recoveryMs) {
      const target = upAnswers + lanes + 1;
      await until(() => upAnswers >= target);
    } else {
      await new Promise((resolve) => setImmediate(resolve));
    }
  };
  const sql: DrillSql = {
    rows: async (text) => {
      if (text.startsWith('select now()')) return [{ t: new Date() }];
      if (text.includes("'done'")) return [{ n: jobs.doubled }];
      if (text.includes('state in')) return [{ n: jobs.stuck }];
      return [{ n: jobs.ran }];
    },
  };
  return {
    fleet,
    modes,
    signals,
    state,
    sql,
    sleep,
    lanes,
    answeredDown: () => downAnswers,
  };
}

const ticking = (): (() => number) => {
  let at = 0;
  return () => {
    at += 1;
    return at;
  };
};

const coded = () =>
  Response.json(
    { code: 'X_DB_UNAVAILABLE' },
    {
      status: 503,
      headers: { 'content-type': 'application/problem+json' },
    },
  );

describe('runDrill', () => {
  test('pg-blackhole: the phase, then pass; coded failures and a recovery hold', async () => {
    const s = stage(coded, undefined, 2);
    const report = await runDrill({
      drill: drillNamed('pg-blackhole') ?? expect.unreachable(),
      fleet: s.fleet,
      budgets,
      targets: [{ method: 'GET', path: '/' }],
      sql: s.sql,
      lanes: s.lanes,
      sleep: s.sleep,
    });
    expect(s.modes).toEqual([{ kind: 'blackhole' }, { kind: 'pass' }]);
    expect(s.answeredDown()).toBeGreaterThanOrEqual(3);
    expect(report.evidence.requests?.failedByCode.get('X_DB_UNAVAILABLE')).toBeGreaterThanOrEqual(
      3,
    );
    expect(report.verdict.failures).toEqual([]);
    expect(report.verdict.ok).toBe(true);
  });

  test('an uncoded 5xx while the dependency is down is red, and nothing else is', async () => {
    // Many lanes, so many requests are on the wire when the fault clears: the recovery wait
    // must not be satisfied by them, or `recovers` goes red on a drill that recovered.
    const s = stage(() => new Response('boom', { status: 500 }), undefined, 32);
    const report = await runDrill({
      drill: drillNamed('pg-blackhole') ?? expect.unreachable(),
      fleet: s.fleet,
      budgets,
      targets: [{ method: 'GET', path: '/' }],
      sql: s.sql,
      lanes: s.lanes,
      sleep: s.sleep,
    });
    expect(report.verdict.ok).toBe(false);
    expect(report.verdict.failures.map((failure) => failure.property)).toEqual(['requests-coded']);
  });

  test('pg-restart plays reset then refuse, and /readyz is sampled through the fault', async () => {
    const s = stage(coded);
    const report = await runDrill({
      drill: drillNamed('pg-restart') ?? expect.unreachable(),
      fleet: s.fleet,
      budgets,
      targets: [{ method: 'GET', path: '/' }],
      sql: s.sql,
      sleep: s.sleep,
    });
    expect(s.modes.map((mode) => mode.kind)).toEqual(['reset', 'refuse', 'pass']);
    expect(report.evidence.readyz?.length).toBeGreaterThan(0);
  });

  test('worker-sigkill signals the worker, brings it back, and reads the jobs', async () => {
    const s = stage(coded, { ran: 4, stuck: 1, doubled: 1 });
    const report = await runDrill({
      drill: drillNamed('worker-sigkill') ?? expect.unreachable(),
      fleet: s.fleet,
      budgets,
      targets: [{ method: 'GET', path: '/' }],
      sql: s.sql,
      sleep: s.sleep,
      // A clock that moves by call, so the jobs settle wait ends without the wall clock.
      now: ticking(),
    });
    expect(s.signals).toEqual(['worker:SIGKILL']);
    expect(s.state.respawns).toBe(1);
    expect(report.evidence.exit?.role).toBe('worker');
    expect(report.verdict.failures.map((failure) => failure.property)).toEqual([
      'jobs-terminal',
      'jobs-once',
    ]);
  });

  test('web-sigterm is never respawned, and its recovery is not a property', async () => {
    const s = stage(coded);
    const report = await runDrill({
      drill: drillNamed('web-sigterm') ?? expect.unreachable(),
      fleet: s.fleet,
      budgets,
      targets: [{ method: 'GET', path: '/' }],
      sql: s.sql,
      sleep: s.sleep,
    });
    expect(s.signals).toEqual(['web:SIGTERM']);
    expect(s.state.respawns).toBe(0);
    expect(report.evidence.recoveryMs).toBeUndefined();
    expect(report.verdict.ok).toBe(true);
  });

  test('a drill whose service has no proxy measures nothing to recover, and is red', async () => {
    const s = stage(coded);
    const report = await runDrill({
      drill: drillNamed('redis-down') ?? expect.unreachable(),
      fleet: s.fleet,
      budgets,
      targets: [{ method: 'GET', path: '/' }],
      sql: s.sql,
      sleep: s.sleep,
    });
    expect(report.verdict.ok).toBe(false);
    expect(report.verdict.failures.map((failure) => failure.property)).toContain('recovers');
  });
});
