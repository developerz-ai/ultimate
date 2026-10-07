// A run killed before its `afterAll` leaves `x_<suite>_<pid>_<hex>` behind; the fixed name it
// replaced was dropped by the next run's `drop … if exists`. The sweep is that next-run drop, kept
// to databases whose run is provably over: its process is dead AND nothing is connected.

import { describe, expect, test } from 'bun:test';
import type { PgExecutor } from './pg-executor';
import { probeDatabaseName } from './probe-database';
import { probeDatabaseAlive, sweepProbeDatabases } from './probe-database-sweep';

interface Row {
  readonly datname: string;
  readonly backends: number;
}

/** A server holding `rows`, recording every statement it is sent. */
function fakeServer(rows: readonly Row[]): PgExecutor & { readonly sent: string[] } {
  const sent: string[] = [];
  return {
    sent,
    query: async <R>(text: string, params: readonly unknown[]): Promise<readonly R[]> => {
      sent.push(params.length === 0 ? text : `${text} -- ${JSON.stringify(params)}`);
      return (text.startsWith('select') ? rows : []) as readonly R[];
    },
  };
}

const MINE = 'x_suite_100_aaaaaaaa';
const dead = (): boolean => false;

describe('sweepProbeDatabases', () => {
  test('drops a sibling whose process is dead and which nothing is connected to', async () => {
    const server = fakeServer([
      { datname: 'x_suite_200_bbbbbbbb', backends: 0 },
      { datname: MINE, backends: 0 },
    ]);
    // Every pid reads dead, so only the self-exclusion keeps its own database alive.
    const swept = await sweepProbeDatabases(server, MINE, { isAlive: () => false });
    expect(swept).toEqual(['x_suite_200_bbbbbbbb']);
    expect(server.sent).toContain('drop database if exists "x_suite_200_bbbbbbbb" with (force)');
    // Its own database is never a candidate, whatever its liveness reads.
    expect(server.sent.some((text) => text.includes(`"${MINE}"`))).toBe(false);
  });

  test('keeps a sibling whose process is alive — a concurrent run on this host', async () => {
    const server = fakeServer([{ datname: 'x_suite_200_bbbbbbbb', backends: 0 }]);
    expect(await sweepProbeDatabases(server, MINE, { isAlive: () => true })).toEqual([]);
    expect(server.sent.some((text) => text.startsWith('drop'))).toBe(false);
  });

  test('keeps a sibling something is connected to — a run on ANOTHER host, pid unknowable', async () => {
    const server = fakeServer([{ datname: 'x_suite_200_bbbbbbbb', backends: 1 }]);
    expect(await sweepProbeDatabases(server, MINE, { isAlive: dead })).toEqual([]);
  });

  test('never touches a name that is not this prefix’s probe shape', async () => {
    const server = fakeServer([
      // A longer prefix sharing ours: `x_suite_extra`'s probe, not ours.
      { datname: 'x_suite_extra_200_bbbbbbbb', backends: 0 },
      { datname: 'x_suite_production', backends: 0 },
    ]);
    expect(await sweepProbeDatabases(server, MINE, { isAlive: () => false })).toEqual([]);
  });

  test('asks the server only for this prefix, with LIKE wildcards escaped', async () => {
    const server = fakeServer([]);
    await sweepProbeDatabases(server, MINE);
    expect(server.sent[0]).toContain('["x\\\\_suite\\\\_%"]');
  });

  test('a name probeDatabaseName did not produce sweeps nothing and sends nothing', async () => {
    const server = fakeServer([]);
    expect(await sweepProbeDatabases(server, 'x_fixed')).toEqual([]);
    expect(server.sent).toEqual([]);
  });

  test('round-trips probeDatabaseName, truncated prefix included', async () => {
    const name = probeDatabaseName('x'.repeat(80), { pid: 7, random: 'cafebabe' });
    const sibling = name.replace('_7_cafebabe', '_8_deadbeef');
    const server = fakeServer([{ datname: sibling, backends: 0 }]);
    expect(await sweepProbeDatabases(server, name, { isAlive: () => false })).toEqual([sibling]);
  });
});

describe('probeDatabaseAlive', () => {
  test('this process is alive, and a pid no process holds is not', () => {
    expect(probeDatabaseAlive(process.pid)).toBe(true);
    expect(probeDatabaseAlive(2 ** 22 + 12_345)).toBe(false);
  });
});
