// Two worker processes of one container (`ULTIMATE_CHILD=0/2`, `1/2`, set by hand as the supervisor
// sets them) over a real Postgres: two CPU-bound jobs run in parallel, and while one child burns the
// other's I/O job keeps renewing its lease. Linux only (the supervisor's platform); skips without
// `TEST_DATABASE_URL`.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { probeDatabaseName, sweepProbeDatabases } from '@ultimat3/core';
import type { PostgresClient } from '@ultimat3/db';
import { dbExecutor, postgresClient, raw } from '@ultimat3/db';
import type { JobDriver } from '@ultimat3/jobs';
import { postgresJobDriver, SQL_JOBS_TABLE } from '@ultimat3/jobs';

const url = Bun.env['TEST_DATABASE_URL'];
const runs = typeof url === 'string' && url.length > 0 && process.platform === 'linux';
const PROBE_DB = probeDatabaseName('x_worker_processes_live');
const CHILD = join(import.meta.dir, 'runtime-jobs-processes-fixture.ts');

interface Event {
  readonly child: string;
  readonly at: number;
  readonly kind: 'ready' | 'start' | 'end' | 'renew' | 'lost';
  readonly job?: 'burn' | 'io';
  readonly k?: string;
  readonly held?: boolean;
  readonly concurrency?: unknown;
}

const KINDS: ReadonlySet<unknown> = new Set(['ready', 'start', 'end', 'renew', 'lost']);

/** A fixture line is an event only with the fields every event carries; anything else is noise. */
const isEvent = (value: unknown): value is Event =>
  typeof value === 'object' &&
  value !== null &&
  'mc' in value &&
  'child' in value &&
  typeof value.child === 'string' &&
  'at' in value &&
  typeof value.at === 'number' &&
  'kind' in value &&
  KINDS.has(value.kind);

const probeUrl = (): string => {
  const parsed = new URL(url ?? 'postgres://localhost/postgres');
  parsed.pathname = `/${PROBE_DB}`;
  return parsed.toString();
};

describe.skipIf(!runs)('live · two worker processes in one container', () => {
  let admin: PostgresClient;
  let client: PostgresClient;
  let driver: JobDriver;
  const events: Event[] = [];
  const children: Bun.Subprocess<'ignore', 'pipe', 'inherit'>[] = [];

  /** Woken on every event, so a wait is for the event itself, never a poll. */
  const listeners = new Set<() => void>();

  /** Reads one child's stdout into `events`, a JSON line at a time. */
  const collect = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
    const decoder = new TextDecoder();
    let buffered = '';
    for await (const chunk of stream) {
      buffered += decoder.decode(chunk, { stream: true });
      const lines = buffered.split('\n');
      buffered = lines.pop() ?? '';
      for (const line of lines) {
        const parsed: unknown = line.startsWith('{') ? JSON.parse(line) : undefined;
        if (isEvent(parsed)) events.push(parsed);
      }
      for (const wake of listeners) wake();
    }
  };

  /** Resolves on the event that makes `check` true; past `ms`, prints what the children did say. */
  const until = (check: () => boolean, ms: number, what: string): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const done = (): void => {
        listeners.delete(onEvent);
        clearTimeout(deadline);
      };
      const onEvent = (): void => {
        if (!check()) return;
        done();
        resolve();
      };
      // real-clock: the children are other processes, burning and waiting on their own time.
      const deadline = setTimeout(() => {
        done();
        try {
          expect.unreachable(`timed out waiting for ${what}: ${JSON.stringify(events)}`);
        } catch (verdict) {
          reject(verdict);
        }
      }, ms);
      listeners.add(onEvent);
      onEvent();
    });

  const find = (kind: Event['kind'], k: string): Event | undefined =>
    events.find((event) => event.kind === kind && event.k === k);

  const enqueue = (name: 'mcBurn' | 'mcIo', k: string) =>
    driver.enqueue({ name, queue: 'mc', input: { k }, idempotencyKey: k, maxAttempts: 1 });

  beforeAll(async () => {
    admin = postgresClient({ url: url ?? '', role: 'web', profile: { max: 1 } });
    await admin.execute(raw(`drop database if exists ${PROBE_DB} with (force)`));
    await sweepProbeDatabases(
      dbExecutor(() => admin),
      PROBE_DB,
    );
    await admin.execute(raw(`create database ${PROBE_DB}`));
    client = postgresClient({ url: probeUrl(), role: 'web', profile: { max: 2 } });
    for (const statement of SQL_JOBS_TABLE.split(';')) {
      if (statement.trim().length > 0) await client.execute(raw(statement));
    }
    driver = postgresJobDriver({
      executor: {
        query: <R>(text: string, values: readonly unknown[]): Promise<readonly R[]> =>
          client.query<R>({ text, values }),
      },
    });
    for (const index of [0, 1]) {
      const child = Bun.spawn([process.execPath, CHILD], {
        env: {
          ...process.env,
          ULTIMATE_CHILD: `${index}/2`,
          MC_DATABASE_URL: probeUrl(),
          NODE_ENV: 'production',
        },
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'inherit',
      });
      children.push(child);
      void collect(child.stdout);
    }
    await until(
      () => events.filter((event) => event.kind === 'ready').length === 2,
      30_000,
      'both children ready',
    );
  }, 60_000);

  afterAll(async () => {
    for (const child of children) child.kill('SIGTERM');
    await Promise.all(children.map((child) => child.exited));
    await client?.close();
    await admin?.execute(raw(`drop database if exists ${PROBE_DB} with (force)`));
    await admin?.close();
  });

  test('each child runs its share of the container: one slot of jobs.concurrency 2', () => {
    const ready = events.filter((event) => event.kind === 'ready');
    expect(ready.map((event) => event.concurrency)).toEqual([{ mc: 1 }, { mc: 1 }]);
  });

  test('two jobs that each burn 1.5 s of CPU run at the same time, one per process', async () => {
    await Promise.all([enqueue('mcBurn', 'burn-a'), enqueue('mcBurn', 'burn-b')]);
    await until(
      () => find('end', 'burn-a') !== undefined && find('end', 'burn-b') !== undefined,
      30_000,
      'both burns',
    );
    // The children's clocks. One process can only run them back to back (a synchronous burn holds
    // its only thread), so the second would start after the first ended. Overlap is the claim, and
    // it holds on a loaded box too; wall time is about 1.5 s when two cores are free.
    const at = (kind: Event['kind'], k: string): number => find(kind, k)?.at ?? Number.NaN;
    const bothStarted = Math.max(at('start', 'burn-a'), at('start', 'burn-b'));
    const firstEnded = Math.min(at('end', 'burn-a'), at('end', 'burn-b'));
    expect(bothStarted).toBeLessThan(firstEnded);
    expect(find('start', 'burn-a')?.child).not.toBe(find('start', 'burn-b')?.child);
  }, 45_000);

  test('an I/O job on one child keeps renewing its lease while the other child burns', async () => {
    await enqueue('mcIo', 'io-1');
    await until(() => find('start', 'io-1') !== undefined, 10_000, 'the io job to start');
    const ioChild = find('start', 'io-1')?.child;
    // Its child holds its one in-flight run, so the burn can only be claimed by the other.
    await enqueue('mcBurn', 'burn-c');
    await until(() => find('end', 'burn-c') !== undefined, 15_000, 'the burn');
    await until(() => find('end', 'io-1') !== undefined, 15_000, 'the io job');
    const burnStart = find('start', 'burn-c');
    const burnEnd = find('end', 'burn-c');
    expect(burnStart?.child).not.toBe(ioChild);
    const during = events.filter(
      (event) =>
        event.kind === 'renew' &&
        event.child === ioChild &&
        event.at >= (burnStart?.at ?? 0) &&
        event.at <= (burnEnd?.at ?? 0),
    );
    expect(during.length).toBeGreaterThanOrEqual(3);
    expect(during.every((event) => event.held === true)).toBe(true);
    expect(events.filter((event) => event.kind === 'lost')).toEqual([]);
  }, 30_000);
});
