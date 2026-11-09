// The jobs evidence: counted once nothing is stuck or the settle window ends, each count from its
// own query, and a stuck job that is reclaimed meanwhile is not reported stuck.

import { describe, expect, test } from 'bun:test';
import { pgliteClient, sql } from '@ultimat3/db';
import type { DrillSql } from './drill-jobs';
import { DOUBLED_SQL, drillJobCounts, RAN_SQL, STUCK_SQL } from './drill-jobs';
import { probeStatus, sampleStatus } from './drill-probe';

const since = new Date('2026-11-06T00:00:00Z');

const scripted = (stuck: number[], ran = 5, doubled = 0): DrillSql & { asked: string[] } => {
  const asked: string[] = [];
  return {
    asked,
    rows: async (text, params) => {
      asked.push(text);
      expect(params).toEqual([since]);
      if (text === STUCK_SQL) return [{ n: stuck.shift() ?? 0 }];
      if (text === RAN_SQL) return [{ n: ran }];
      if (text === DOUBLED_SQL) return [{ n: String(doubled) }];
      return expect.unreachable(`unexpected query ${text}`);
    },
  };
};

describe('drillJobCounts', () => {
  test('waits while a job is stuck, and reports it gone once reclaimed', async () => {
    const sql = scripted([2, 1, 0], 5, 1);
    const counts = await drillJobCounts({
      sql,
      since,
      settleMs: 1_000,
      now: () => 0,
      sleep: async () => undefined,
    });
    expect(counts).toEqual({ ran: 5, stuck: 0, doubled: 1 });
    expect(sql.asked.filter((text) => text === STUCK_SQL)).toHaveLength(3);
  });

  test('past the settle window a stuck job is reported stuck', async () => {
    let at = 0;
    const counts = await drillJobCounts({
      sql: scripted([3, 3, 3, 3, 3, 3]),
      since,
      settleMs: 2,
      now: () => {
        at += 1;
        return at;
      },
      sleep: async () => undefined,
    });
    expect(counts.stuck).toBe(3);
  });

  test('the doubled query counts a key run twice at once, never one enqueued again after it settled', async () => {
    // The live-row dedupe holds while the first row is live; a load that sends the same key after
    // it finished gets a new job by design. Counting that read a timing-dependent red in CI.
    const client = pgliteClient();
    try {
      await client.execute(
        sql`create table x_jobs (id text primary key, name text, tenant_id text, idempotency_key text, state text, created_at timestamptz, updated_at timestamptz, run_at timestamptz default now())`,
      );
      const at = (s: number) => new Date(Date.UTC(2026, 10, 7, 12, 0, s)).toISOString();
      const rows: readonly (readonly string[])[] = [
        // `overlap`: the second row was created while the first was still live — a real double.
        ['a1', 'mail', 'overlap', 'done', at(0), at(10)],
        ['a2', 'mail', 'overlap', 'done', at(5), at(12)],
        // `again`: enqueued again after the first settled — two jobs, no double.
        ['b1', 'mail', 'again', 'done', at(0), at(2)],
        ['b2', 'mail', 'again', 'done', at(3), at(4)],
      ];
      for (const [id, name, key, state, created, updated] of rows) {
        await client.execute(
          sql`insert into x_jobs values (${id}, ${name}, null, ${key}, ${state}, ${created}, ${updated})`,
        );
      }
      const drill = {
        rows: (text: string, params: readonly unknown[]) =>
          client.query<Record<string, unknown>>({ text, values: params }),
      };
      const counts = await drillJobCounts({ sql: drill, since: new Date(at(0)), settleMs: 0 });
      expect(counts.doubled).toBe(1);
    } finally {
      await client.close();
    }
  });
});

describe('probeStatus', () => {
  test('the status a real server answers, and null for a port nothing holds', async () => {
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => new Response(null, { status: 503 }),
    });
    try {
      expect(await probeStatus(`http://127.0.0.1:${String(server.port)}/readyz`, 1_000)).toBe(503);
    } finally {
      server.stop(true);
    }
    // Port 1 (tcpmux), privileged and never served — not the port just freed, which a busy
    // machine hands straight to another process (one answered 308 here).
    expect(await probeStatus('http://127.0.0.1:1/readyz', 1_000)).toBeNull();
  });

  test('sampleStatus records each answer against the fault start', async () => {
    const answers = [200, 503, null];
    let at = 100;
    const sampler = sampleStatus({
      url: 'http://unused',
      everyMs: 10,
      boundMs: 10,
      zero: 100,
      now: () => at,
      sleep: async () => {
        at += 10;
        await new Promise((resolve) => setImmediate(resolve));
      },
      probe: async () => (answers.length === 0 ? 200 : (answers.shift() ?? null)),
    });
    await new Promise((resolve) => setImmediate(resolve));
    const samples = await sampler.stop();
    expect(samples[0]).toEqual({ atMs: 0, status: 200 });
    expect(samples.length).toBeGreaterThanOrEqual(1);
  });
});
