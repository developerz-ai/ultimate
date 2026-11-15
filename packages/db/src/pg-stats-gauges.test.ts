// The Postgres stats collector: each server fact lands on its gauge, a dropped slot reads 0 instead
// of its last size, a value the driver did not send as a finite number writes nothing, and a failed
// round neither throws nor logs twice in one streak.

import { afterEach, describe, expect, test } from 'bun:test';
import { collectMetrics, installLogSink } from '@ultimat3/core';
import { dbUnavailable } from './errors';
import { pgStatsSampler, startPgStatsGauges } from './pg-stats-gauges';
import { PG_SERVER_STATS_SQL, PG_SLOT_STATS_SQL } from './pg-stats-sql';

const points = (name: string) =>
  collectMetrics().metrics.find((metric) => metric.descriptor.name === name)?.points ?? [];

const value = (name: string, slot?: string): number | undefined =>
  points(name).find((point) => slot === undefined || point.attributes['slot'] === slot)?.value;

interface Answer {
  server: readonly Record<string, unknown>[];
  slots: readonly Record<string, unknown>[];
}

const executor = (answer: Answer) => ({
  statements: [] as string[],
  async query<R>(text: string): Promise<readonly R[]> {
    this.statements.push(text);
    if (text === PG_SERVER_STATS_SQL) return answer.server as readonly R[];
    if (text === PG_SLOT_STATS_SQL) return answer.slots as readonly R[];
    return expect.unreachable(`an unexpected statement: ${text}`);
  },
});

const SERVER = {
  connections: 42,
  max_connections: 100,
  longest_transaction_seconds: 12.5,
  autovacuum_backlog_ratio: 1.75,
};

let releaseSink: (() => void) | undefined;
afterEach(() => {
  releaseSink?.();
  releaseSink = undefined;
});

describe('unit · the Postgres stats gauges', () => {
  test('each server fact lands on its gauge, each slot on its own series', async () => {
    const pg = executor({
      server: [SERVER],
      slots: [{ slot: 'ultimate_live', retained_bytes: 4096 }],
    });
    await pgStatsSampler(pg).sample();
    expect([
      value('db_server_connections'),
      value('db_server_max_connections'),
      value('db_longest_transaction_seconds'),
      value('db_autovacuum_backlog_ratio'),
      value('db_replication_slot_retained_bytes', 'ultimate_live'),
    ]).toEqual([42, 100, 12.5, 1.75, 4096]);
    // Two statements per round, both constant: nothing an app supplies reaches the server.
    expect(pg.statements).toEqual([PG_SERVER_STATS_SQL, PG_SLOT_STATS_SQL]);
  });

  test('a slot that is gone reads 0 on the next round, not its last size forever', async () => {
    const answer: Answer = { server: [SERVER], slots: [{ slot: 'gone_slot', retained_bytes: 9 }] };
    const sampler = pgStatsSampler(executor(answer));
    await sampler.sample();
    expect(value('db_replication_slot_retained_bytes', 'gone_slot')).toBe(9);
    answer.slots = [];
    await sampler.sample();
    expect(value('db_replication_slot_retained_bytes', 'gone_slot')).toBe(0);
  });

  test('a value that is not a finite number writes nothing on its gauge', async () => {
    const sampler = pgStatsSampler(executor({ server: [SERVER], slots: [] }));
    await sampler.sample();
    await pgStatsSampler(
      executor({ server: [{ ...SERVER, connections: '17', max_connections: null }], slots: [] }),
    ).sample();
    expect([value('db_server_connections'), value('db_server_max_connections')]).toEqual([42, 100]);
  });

  test('a failing round never throws, and a streak of failures logs one line', async () => {
    const lines: string[] = [];
    releaseSink = installLogSink((line) => {
      lines.push(line);
    });
    let fail = true;
    const sampler = pgStatsSampler({
      async query<R>(text: string): Promise<readonly R[]> {
        if (fail) throw dbUnavailable('connection refused');
        return (text === PG_SERVER_STATS_SQL ? [SERVER] : []) as unknown as readonly R[];
      },
    });
    await sampler.sample();
    await sampler.sample();
    expect(lines.filter((line) => line.includes('db.stats.sample-failed')).length).toBe(1);
    fail = false;
    await sampler.sample();
    fail = true;
    await sampler.sample();
    expect(lines.filter((line) => line.includes('db.stats.sample-failed')).length).toBe(2);
  });

  test('db_stats_sample_ok says whether the last round landed, so frozen values are visible', async () => {
    let fail = false;
    const sampler = pgStatsSampler({
      async query<R>(text: string): Promise<readonly R[]> {
        if (fail) throw dbUnavailable('connection refused');
        return (text === PG_SERVER_STATS_SQL ? [SERVER] : []) as unknown as readonly R[];
      },
    });
    await sampler.sample();
    expect(value('db_stats_sample_ok')).toBe(1);
    fail = true;
    await sampler.sample();
    expect(value('db_stats_sample_ok')).toBe(0);
    fail = false;
    await sampler.sample();
    expect(value('db_stats_sample_ok')).toBe(1);
  });

  test('started, it samples at once and stops when asked', async () => {
    const pg = executor({ server: [SERVER], slots: [] });
    const stop = startPgStatsGauges(pg, 60_000);
    await Bun.sleep(0);
    await stop();
    expect(pg.statements).toEqual([PG_SERVER_STATS_SQL, PG_SLOT_STATS_SQL]);
  });

  test('stop waits out the round in flight, so it never runs against a closing pool', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let settled = false;
    const stop = startPgStatsGauges({
      async query<R>(text: string): Promise<readonly R[]> {
        await gate;
        if (text === PG_SLOT_STATS_SQL) settled = true;
        return (text === PG_SERVER_STATS_SQL ? [SERVER] : []) as unknown as readonly R[];
      },
    });
    let stopped = false;
    const stopping = stop().then(() => {
      stopped = true;
    });
    await Bun.sleep(5);
    expect(stopped).toBe(false);
    release();
    await stopping;
    expect([stopped, settled]).toEqual([true, true]);
  });
});
