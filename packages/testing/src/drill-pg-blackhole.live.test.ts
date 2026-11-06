// The drill's negative control: `pg-blackhole` played on a real pool through a real fault proxy,
// twice — with the role's unanswered-statement bound, and with it off through the pool's own seam
// (`profile.statementTimeoutMs: 0`, what `migrate` runs on). The fix from plan 29 (pg-unanswered)
// reverted must turn the drill red, or the drill proves nothing. Skips unless `TEST_DATABASE_URL`.

import { afterEach, describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import { postgresClient, sql } from '@ultimat3/db';
import type { DrillFleet, DrillRoleProcess } from './drill-fleet';
import type { DrillSql } from './drill-jobs';
import type { DrillReport } from './drill-run';
import { runDrill } from './drill-run';
import type { DrillService } from './drills';
import { drillNamed } from './drills';
import type { FaultProxy } from './fault-proxy';
import { faultProxy, faultTarget, throughFaultProxy } from './fault-proxy';
import { allowHost, resetNetwork } from './sealed-network';
import { testName } from './test-types';

const adminUrl = Bun.env['TEST_DATABASE_URL'] ?? '';

/** Statement bound 300 ms: the pool's sweep answers a blackholed statement at 300 + 5,000 + 1 tick. */
const STATEMENT_MS = 300;

/**
 * Past that miss, so a request bounded by it meets it inside the deadline; the phase is
 * `drillBudgets`' own — one deadline plus one bounded delay — so an unbounded request outlives it.
 */
const budgets = {
  deadlineMs: 8_000,
  promptMs: 1_000,
  recoveryMs: 8_000,
  readinessMs: 8_000,
  drainMs: 1_000,
  readiness: 'dependencies' as const,
  phaseMs: 9_000,
};

/** The jobs evidence is not this test's question: an empty queue, read without a database. */
const noJobs: DrillSql = {
  rows: async (text) => (text.startsWith('select now()') ? [{ t: new Date() }] : [{ n: 0 }]),
};

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  resetNetwork();
});

/** A web role whose one route runs a statement through the pool, answering a coded failure coded. */
async function play(statementTimeoutMs: number): Promise<DrillReport> {
  const proxy: FaultProxy = await faultProxy({ target: faultTarget(adminUrl) });
  cleanups.push(() => proxy.close());
  const client = postgresClient({
    url: throughFaultProxy(adminUrl, proxy.port),
    role: 'web',
    profile: { statementTimeoutMs },
    env: {},
  });
  cleanups.push(() => client.close());
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname === '/readyz') return new Response('ok');
      try {
        await client.query(sql`select 1 as one`);
        return new Response('ok');
      } catch (error) {
        const code = isUltimateError(error) ? error.code : 'X_INTERNAL';
        return Response.json(
          { code },
          { status: 503, headers: { 'content-type': 'application/problem+json' } },
        );
      }
    },
  });
  cleanups.push(() => void server.stop(true));
  allowHost(`127.0.0.1:${String(server.port)}`);
  const base = `http://127.0.0.1:${String(server.port)}`;
  const web: DrillRoleProcess = {
    role: 'web',
    origin: base,
    readyz: `${base}/readyz`,
    signal: () => undefined,
    exited: async () => 0,
    respawn: async () => undefined,
    log: () => '',
  };
  const fleet: DrillFleet = {
    base,
    databaseUrl: adminUrl,
    proxies: new Map<DrillService, FaultProxy>([['postgres', proxy]]),
    roles: new Map([['web', web]]),
    stop: async () => undefined,
  };
  // real-clock: the pool's sweep, a blackholed socket and the server behind it keep real time.
  return runDrill({
    drill: drillNamed('pg-blackhole') ?? expect.unreachable(),
    fleet,
    budgets,
    targets: [{ method: 'GET', path: '/' }],
    sql: noJobs,
    lanes: 2,
  });
}

describe.skipIf(adminUrl === '')(testName('live', 'pg-blackhole, fix and fix reverted'), () => {
  test(
    'with the bound, a blackholed statement is a coded 503 inside the deadline: held',
    async () => {
      const report = await play(STATEMENT_MS);
      expect(report.evidence.requests?.failedByCode.get('X_DB_UNAVAILABLE')).toBeGreaterThan(0);
      expect(report.verdict.failures).toEqual([]);
      expect(report.verdict.ok).toBe(true);
    },
    { timeout: 90_000 },
  );

  test(
    'with the bound off through the pool seam, the drill is red on requests-bounded',
    async () => {
      const report = await play(0);
      expect(report.verdict.ok).toBe(false);
      expect(report.verdict.failures.map((failure) => failure.property)).toContain(
        'requests-bounded',
      );
    },
    { timeout: 90_000 },
  );
});
