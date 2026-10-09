// The Redis driver's TypeScript half — what it binds into each script and how it reads each reply —
// against a client that records every command and answers from a table. The scripts themselves
// run only on a real server: `driver-redis.live.test.ts` and the conformance suite.

import { describe, expect, test } from 'bun:test';
import { frozenClock } from '@ultimat3/core';
import { LEASE_LAPSED_FINAL_ATTEMPT } from './driver';
import type { RedisSender } from './driver-redis';
import { redisJobDriver } from './driver-redis';
import {
  REDIS_ACK,
  REDIS_CLAIM,
  REDIS_ENQUEUE,
  REDIS_HEARTBEAT,
  REDIS_NACK,
  REDIS_STATS,
  REDIS_STEP_PUT_FENCED,
} from './driver-redis-scripts';

const SCRIPTS = new Map<string, string>([
  [REDIS_ENQUEUE, 'enqueue'],
  [REDIS_CLAIM, 'claim'],
  [REDIS_ACK, 'ack'],
  [REDIS_NACK, 'nack'],
  [REDIS_HEARTBEAT, 'heartbeat'],
  [REDIS_STATS, 'stats'],
  [REDIS_STEP_PUT_FENCED, 'step-put'],
]);

interface Sent {
  readonly command: string;
  /** The script's name for an `EVAL`, then its arguments after the namespace. */
  readonly args: readonly string[];
}

/** A client that records each command and answers from `replies`, by script name or command. */
function recording(replies: Readonly<Record<string, unknown>>) {
  const sent: Sent[] = [];
  const client: RedisSender = {
    send(command, args) {
      if (command !== 'EVAL') {
        sent.push({ command, args });
        return Promise.resolve(replies[command]);
      }
      const [script = '', , key, ns, ...rest] = args;
      const name = SCRIPTS.get(script) ?? 'unknown';
      sent.push({ command: name, args: [key ?? '', ns ?? '', ...rest] });
      return Promise.resolve(replies[name]);
    },
  };
  return { client, sent };
}

const AT = Date.parse('2026-10-01T00:00:00.000Z');
const clock = () => frozenClock(AT);

/** A stored row as `HGETALL` answers it: a flat field/value list. */
const row = (fields: Readonly<Record<string, string>>): string[] => Object.entries(fields).flat();

const STORED = {
  id: 'j1',
  name: 'mail.send',
  queue: 'default',
  input: '{"to":"a@b.c"}',
  idempotencyKey: 'k',
  runId: 'r1',
  attempt: '1',
  maxAttempts: '3',
  state: 'running',
  runAt: String(AT),
  createdAt: String(AT),
  updatedAt: String(AT),
  claim: '1',
  claimedBy: 'w1',
  claimedAt: String(AT),
  visibleAt: String(AT + 30_000),
  tenantId: 'org-1',
};

describe('redisJobDriver', () => {
  test('enqueue binds every field, in the slot the namespace names', async () => {
    const { client, sent } = recording({ enqueue: ['created', 'j1', 'r1'] });
    const driver = redisJobDriver({ client, clock: clock(), prefix: 'app' });
    const answer = await driver.enqueue({
      id: 'j1',
      runId: 'r1',
      name: 'mail.send',
      queue: '',
      input: { to: 'a@b.c' },
      idempotencyKey: 'k',
      maxAttempts: 3,
      tenantId: 'org-1',
      traceparent: 'tp',
      enqueuedBy: 'u1',
    });
    expect(answer).toEqual({ id: 'j1', runId: 'r1', deduped: false });
    expect(sent).toEqual([
      {
        command: 'enqueue',
        args: [
          '{app}:queues',
          '{app}',
          'j1',
          'mail.send',
          'default',
          '{"to":"a@b.c"}',
          'k',
          'r1',
          '3',
          String(AT),
          String(AT),
          'org-1',
          'tp',
          'u1',
          '["mail.send","org-1","k"]',
        ],
      },
    ]);
  });

  test('a deduped enqueue answers the holder, and onConflict: error refuses it', async () => {
    const { client } = recording({ enqueue: ['deduped', 'held', 'held-run'] });
    const driver = redisJobDriver({ client, clock: clock() });
    const request = { name: 'n', queue: 'q', input: null, idempotencyKey: 'k', maxAttempts: 1 };
    expect(await driver.enqueue(request)).toEqual({ id: 'held', runId: 'held-run', deduped: true });
    await expect(driver.enqueue({ ...request, onConflict: 'error' })).rejects.toMatchObject({
      code: 'X_JOB_DUPLICATE',
    });
  });

  test('claim reads claimed and buried rows apart, and reports the buried once', async () => {
    const buried = { ...STORED, id: 'j2', state: 'dead', lastError: LEASE_LAPSED_FINAL_ATTEMPT };
    delete (buried as Partial<typeof STORED>).claimedBy;
    const { client, sent } = recording({
      claim: [
        ['c', row(STORED)],
        ['b', row(buried)],
      ],
    });
    const driver = redisJobDriver({ client, clock: clock() });
    const reported: string[][] = [];
    const claimed = await driver.claim({
      queues: ['default', 'other'],
      limit: 5,
      visibilityTimeoutMs: 30_000,
      workerId: 'w1',
      dropExhausted: ['quiet.job'],
      onExhausted: (dead) => reported.push(dead.map((each) => `${each.id}:${each.state}`)),
    });
    expect(claimed).toEqual([
      {
        id: 'j1',
        name: 'mail.send',
        queue: 'default',
        input: { to: 'a@b.c' },
        idempotencyKey: 'k',
        runId: 'r1',
        attempt: 1,
        maxAttempts: 3,
        state: 'running',
        runAt: AT,
        createdAt: AT,
        updatedAt: AT,
        tenantId: 'org-1',
        claimedBy: 'w1',
        claim: 1,
        claimedAt: AT,
        visibleAt: AT + 30_000,
      },
    ]);
    expect(reported).toEqual([['j2:dead']]);
    expect(sent[0]?.args.slice(2)).toEqual([
      String(AT),
      '5',
      '30000',
      'w1',
      '1',
      'quiet.job',
      'default',
      'other',
    ]);
  });

  test('claim refuses an empty queue list and a bound that is not a count', async () => {
    const driver = redisJobDriver({ client: recording({}).client, clock: clock() });
    const at = { limit: 1, visibilityTimeoutMs: 1, workerId: 'w' };
    await expect(driver.claim({ ...at, queues: [] })).rejects.toMatchObject({
      code: 'X_JOB_CLAIM_QUEUES_EMPTY',
    });
    await expect(driver.claim({ ...at, queues: ['q'], limit: -1 })).rejects.toThrow();
  });

  test('a row in a state the list does not know reads as dead, never cast', async () => {
    const odd = { ...STORED, state: 'exploded' };
    const { client } = recording({ claim: [['b', row(odd)]] });
    const driver = redisJobDriver({ client, clock: clock() });
    let state = '';
    await driver.claim({
      queues: ['q'],
      limit: 1,
      visibilityTimeoutMs: 1,
      workerId: 'w',
      onExhausted: ([dead]) => {
        state = dead?.state ?? '';
      },
    });
    expect(state).toBe('dead');
  });

  test('ack, nack and heartbeat bind their fence and answer whether the script landed', async () => {
    const { client, sent } = recording({ ack: 1, nack: 0, heartbeat: 1 });
    const driver = redisJobDriver({ client, clock: clock(), doneTtlMs: 0 });
    const by = { workerId: 'w1', claim: 2 };
    expect(await driver.ack('j1', by)).toBe(true);
    expect(await driver.nack('j1', { ...by, delayMs: 500, error: 'boom', stack: 'at x' })).toBe(
      false,
    );
    expect(await driver.nack('j1', { ...by, delayMs: 0, park: true, countsAsAttempt: false })).toBe(
      false,
    );
    expect(await driver.heartbeat('j1', { visibilityTimeoutMs: 1_000 })).toBe(true);
    expect(sent.map((each) => [each.command, ...each.args.slice(2)])).toEqual([
      ['ack', 'j1', 'w1', '2', String(AT), '0'],
      ['nack', 'j1', 'w1', '2', String(AT), 'ready', String(AT + 500), '1', '1', 'boom', 'at x'],
      ['nack', 'j1', 'w1', '2', String(AT), 'suspended', String(AT), '0', '0', '', ''],
      ['heartbeat', 'j1', '', '', String(AT + 1_000)],
    ]);
  });

  test('stats reads one row per queue, sorted by code unit, oldest from the due score', async () => {
    const { client } = recording({
      stats: [
        ['b', 2, 1, 0, 0, 0, 1, String(AT - 5_000)],
        ['B', 0, 0, 1, 1, 1, 0, -1],
      ],
    });
    const driver = redisJobDriver({ client, clock: clock() });
    expect(await driver.stats()).toEqual([
      {
        queue: 'B',
        ready: 0,
        delayed: 0,
        running: 1,
        suspended: 1,
        failed: 1,
        dead: 0,
        oldestReadyMs: 0,
      },
      {
        queue: 'b',
        ready: 2,
        delayed: 1,
        running: 0,
        suspended: 0,
        failed: 0,
        dead: 1,
        oldestReadyMs: 5_000,
      },
    ]);
  });

  test('the step store keeps JSON per run, and a fenced write that missed is X_JOB_LEASE_LOST', async () => {
    const stored = (name: string, startedAt: number) =>
      JSON.stringify({ runId: 'r1', name, status: 'completed', output: 1, startedAt, attempts: 1 });
    const { client, sent } = recording({
      HGET: stored('a', 1),
      HVALS: [stored('b', 2), stored('a', 1), '{"status":"unknown"}'],
      'step-put': 0,
    });
    const steps = redisJobDriver({ client, clock: clock(), prefix: 'p' }).steps;
    const record = {
      runId: 'r1',
      name: 'a',
      status: 'completed' as const,
      startedAt: 1,
      attempts: 1,
    };
    await steps.put(record);
    await expect(
      steps.put(record, { job: 'mail.send', jobId: 'j1', workerId: 'w1', claim: 1 }),
    ).rejects.toMatchObject({ code: 'X_JOB_LEASE_LOST' });
    expect((await steps.get('r1', 'a'))?.name).toBe('a');
    expect((await steps.list('r1')).map((each) => each.name)).toEqual(['a', 'b']);
    await steps.del('r1', 'a');
    await steps.clear('r1');
    expect(sent.map((each) => each.command)).toEqual([
      'HSET',
      'step-put',
      'HGET',
      'HVALS',
      'HDEL',
      'DEL',
    ]);
    const [key, field, text] = sent[0]?.args ?? [];
    expect([key, field, JSON.parse(text ?? 'null')]).toEqual([
      '{p}:steps:r1',
      'a',
      { ...record, output: null },
    ]);
  });
});
