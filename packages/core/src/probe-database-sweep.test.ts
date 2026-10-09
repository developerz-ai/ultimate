// A run killed before its `afterAll` leaves `x_<suite>_<pid>_<hex>` behind; the fixed name it
// replaced was dropped by the next run's `drop … if exists`. The sweep is that next-run drop, kept
// to databases whose run is provably over: its process is dead AND nothing is connected.

import { describe, expect, test } from 'bun:test';
import type { PgExecutor } from './pg-executor';
import { probeDatabaseName } from './probe-database';
import {
  PROBE_DATABASE_MIN_AGE_MS,
  probeDatabaseAlive,
  sweepProbeDatabases,
  sweepStaleProbeDatabases,
} from './probe-database-sweep';

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

/** The sweep's clock; `OLD` is 11 minutes before it, `YOUNG` one minute. */
const NOW = 1_800_000_000_000;
const clock = (): number => NOW;
const OLD = 'tro8do';
const YOUNG = 'tro8uc';
const MINE = `x_suite_100_${OLD}_aaaaaaaa`;
const SIBLING = `x_suite_200_${OLD}_bbbbbbbb`;
const dead = (): boolean => false;

describe('sweepProbeDatabases', () => {
  test('drops a sibling whose process is dead and which nothing is connected to', async () => {
    const server = fakeServer([
      { datname: SIBLING, backends: 0 },
      { datname: MINE, backends: 0 },
    ]);
    // Every pid reads dead, so only the self-exclusion keeps its own database alive.
    const swept = await sweepProbeDatabases(server, MINE, { isAlive: () => false, now: clock });
    expect(swept).toEqual([SIBLING]);
    expect(server.sent).toContain(`drop database if exists "${SIBLING}" with (force)`);
    // Its own database is never a candidate, whatever its liveness reads.
    expect(server.sent.some((text) => text.includes(`"${MINE}"`))).toBe(false);
  });

  test('keeps a sibling whose process is alive — a concurrent run on this host', async () => {
    const server = fakeServer([{ datname: SIBLING, backends: 0 }]);
    expect(await sweepProbeDatabases(server, MINE, { isAlive: () => true, now: clock })).toEqual(
      [],
    );
    expect(server.sent.some((text) => text.startsWith('drop'))).toBe(false);
  });

  test('keeps a sibling something is connected to — a run on ANOTHER host, pid unknowable', async () => {
    const server = fakeServer([{ datname: SIBLING, backends: 1 }]);
    expect(await sweepProbeDatabases(server, MINE, { isAlive: dead, now: clock })).toEqual([]);
  });

  test('keeps a dead, idle sibling younger than the minimum age — created, not yet connected', async () => {
    // Another host's run between its `create database` and its first query: its pid reads dead here
    // and nothing is connected yet. Only its age tells it from a killed run's leftover.
    const young = `x_suite_200_${YOUNG}_bbbbbbbb`;
    const server = fakeServer([{ datname: young, backends: 0 }]);
    expect(await sweepProbeDatabases(server, MINE, { isAlive: dead, now: clock })).toEqual([]);
    expect(PROBE_DATABASE_MIN_AGE_MS).toBe(10 * 60 * 1000);
  });

  test('never touches a name that is not this prefix’s probe shape', async () => {
    const server = fakeServer([
      // A longer prefix sharing ours: `x_suite_extra`'s probe, not ours.
      { datname: `x_suite_extra_200_${OLD}_bbbbbbbb`, backends: 0 },
      { datname: 'x_suite_production', backends: 0 },
    ]);
    expect(await sweepProbeDatabases(server, MINE, { isAlive: () => false, now: clock })).toEqual(
      [],
    );
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
    const name = probeDatabaseName('x'.repeat(80), {
      pid: 7,
      random: 'cafebabe',
      now: NOW - 11 * 60_000,
    });
    const sibling = name.replace('_7_', '_8_').replace('_cafebabe', '_deadbeef');
    const server = fakeServer([{ datname: sibling, backends: 0 }]);
    expect(await sweepProbeDatabases(server, name, { isAlive: () => false, now: clock })).toEqual([
      sibling,
    ]);
  });
});

describe('probeDatabaseAlive', () => {
  test('this process is alive, and a pid no process holds is not', () => {
    expect(probeDatabaseAlive(process.pid)).toBe(true);
    expect(probeDatabaseAlive(2 ** 22 + 12_345)).toBe(false);
  });
});

// #738: a suite only swept its OWN prefix, and only when it ran again — a suite that was renamed or
// deleted left its probes forever. The test runner and `x clean` sweep every probe-shaped name.
describe('sweepStaleProbeDatabases', () => {
  const OTHER = `x_other_suite_300_${OLD}_cccccccc`;
  const FRESH = `x_suite_400_${YOUNG}_dddddddd`;
  const USERS = 'notificado_dev';

  test('drops every dead, idle, old probe of any prefix; nothing else', async () => {
    const server = fakeServer([
      { datname: SIBLING, backends: 0 },
      { datname: OTHER, backends: 0 },
      { datname: FRESH, backends: 0 },
      { datname: `x_busy_500_${OLD}_eeeeeeee`, backends: 1 },
      { datname: USERS, backends: 0 },
    ]);
    const swept = await sweepStaleProbeDatabases(server, { isAlive: dead, now: clock });
    expect([...swept].sort()).toEqual([OTHER, SIBLING].sort());
    expect(server.sent.filter((text) => text.startsWith('drop'))).toHaveLength(2);
  });

  test('`dryRun` names them and drops nothing', async () => {
    const server = fakeServer([{ datname: SIBLING, backends: 0 }]);
    expect(
      await sweepStaleProbeDatabases(server, { isAlive: dead, now: clock, dryRun: true }),
    ).toEqual([SIBLING]);
    expect(server.sent.some((text) => text.startsWith('drop'))).toBe(false);
  });
});
