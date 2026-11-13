// A step answers what it stored. The first run used to hand back the live value and a replay the
// JSON, so `s.run('stamp', () => new Date(0))` then `.getTime()` passed on attempt 1 and threw a
// `TypeError` on the resume — a path no test without a replay ever walked.

import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { isUltimateError, logger } from '@ultimat3/core';
import { DEFAULT_RETRY } from './retry';
import { nextRetryForError } from './retry-classification';
import { stepRunner } from './steps';
import { memoryStepStore } from './steps-memory';
import { STEP_OUTPUT_MAX_BYTES } from './steps-output';

const AT = new Date('2026-11-02T09:00:00.000Z');

/** The same step, on attempt 1 and on the attempt that replays it. Asserts `fn` ran once. */
async function twoAttempts(fn: () => unknown): Promise<{ first: unknown; replay: unknown }> {
  const store = memoryStepStore();
  let runs = 0;
  const body = (): (() => unknown) => () => {
    runs += 1;
    return fn();
  };
  const first = await stepRunner({ runId: 'r', jobName: 'j', store }).step.run('s', body());
  const replay = await stepRunner({ runId: 'r', jobName: 'j', store }).step.run('s', body());
  expect(runs).toBe(1);
  return { first, replay };
}

describe('step.run answers the stored form on every attempt', () => {
  const cases: readonly (readonly [string, () => unknown, unknown])[] = [
    ['a Date', () => AT, AT.toISOString()],
    ['a nested Date', () => ({ at: AT }), { at: AT.toISOString() }],
    ['a Map', () => new Map([['k', 1]]), {}],
    ['undefined at the top', () => undefined, null],
    ['undefined on a member', () => ({ a: undefined, b: 1 }), { b: 1 }],
    ['undefined in an array', () => [undefined, 1], [null, 1]],
    ['a function at the top', () => () => 1, null],
    ['a function member', () => ({ f: () => 1, b: 1 }), { b: 1 }],
    ['a toJSON()', () => ({ toJSON: () => ({ wire: true }) }), { wire: true }],
    ['null', () => null, null],
  ];

  for (const [label, fn, stored] of cases) {
    test(`${label}: first run and replay are the one stored value`, async () => {
      const { first, replay } = await twoAttempts(fn);
      expect(first).toEqual(stored);
      expect(replay).toEqual(stored);
    });
  }

  test('the value on attempt 1 is already a string, so the misuse fails where a test can see it', async () => {
    const stored = memoryStepStore();
    const value: unknown = await stepRunner({ runId: 'r', jobName: 'j', store: stored }).step.run(
      'stamp',
      () => new Date(0),
    );
    expect(typeof value).toBe('string');
    expect(value).toBe('1970-01-01T00:00:00.000Z');
  });

  test('a mutation of what the body returned cannot reach the answer', async () => {
    const live = { n: 1 };
    const answer = await stepRunner({
      runId: 'r',
      jobName: 'j',
      store: memoryStepStore(),
    }).step.run('s', () => live);
    live.n = 2;
    expect(answer).toEqual({ n: 1 });
  });
});

describe('a value JSON cannot hold is refused, once, for good', () => {
  const cycle = (): unknown => {
    const node: { self?: unknown } = {};
    node.self = node;
    return node;
  };

  for (const [label, fn] of [
    ['a bigint', () => 12n],
    ['a nested bigint', () => ({ id: 12n })],
    ['a cycle', cycle],
  ] as const) {
    test(`${label} raises the code, terminally`, async () => {
      const store = memoryStepStore();
      const thrown: unknown = await stepRunner({ runId: 'r', jobName: 'j', store })
        .step.run('s', fn)
        .catch((error: unknown) => error);

      if (!isUltimateError(thrown)) return expect.unreachable('expected a coded refusal');
      expect(thrown.code).toBe('X_STEP_OUTPUT_UNSERIALIZABLE');
      expect(thrown.cause).toContain('"s"');
      expect(thrown.fix).toContain('String(id)');
      expect(nextRetryForError(DEFAULT_RETRY, 1, thrown).stoppedBy).toBe('terminal');
      // The refusal is the run's own history, recorded like any failure; no `completed` row.
      expect((await store.get('r', 's'))?.status).toBe('failed');
    });
  }
});

describe('what jsonb or the type could not honestly hold is refused', () => {
  for (const [label, fn] of [
    ['a NUL in a string', () => 'vendor\u0000note'],
    ['a NUL in a key', () => ({ 'a\u0000': 1 })],
    ['a lone surrogate', () => ({ note: 'x\ud83d' })],
    ['NaN', () => Number.NaN],
    ['a nested Infinity', () => ({ total: [Number.POSITIVE_INFINITY] })],
    ['an invalid Date', () => ({ at: new Date(Number.NaN) })],
  ] as const) {
    test(`${label} raises the code, terminally, and the body ran once`, async () => {
      const store = memoryStepStore();
      let runs = 0;
      const attempt = () =>
        stepRunner({ runId: 'r', jobName: 'j', store })
          .step.run('s', () => {
            runs += 1;
            return fn();
          })
          .catch((error: unknown) => error);

      const thrown = await attempt();
      if (!isUltimateError(thrown)) return expect.unreachable('expected a coded refusal');
      expect(thrown.code).toBe('X_STEP_OUTPUT_UNSERIALIZABLE');
      expect(nextRetryForError(DEFAULT_RETRY, 1, thrown).stoppedBy).toBe('terminal');
      expect(runs).toBe(1);
    });
  }

  test('a real null, a valid Date and a surrogate pair still pass', async () => {
    const { first } = await twoAttempts(() => ({ a: null, at: AT, smile: '😀' }));
    expect(first).toEqual({ a: null, at: AT.toISOString(), smile: '😀' });
  });
});

describe('one key order, the one jsonb stores', () => {
  const orderOf = (value: unknown): string[] => Object.keys(value as Record<string, unknown>);

  test('shorter keys first, then by bytes, on the first run and the replay', async () => {
    const { first, replay } = await twoAttempts(() => ({ zebra: 1, a: 2, bb: 3, é: 4, z: 5 }));
    expect(orderOf(first)).toEqual(['a', 'z', 'bb', 'é', 'zebra']);
    expect(orderOf(replay)).toEqual(orderOf(first));
  });

  test('nested, and through an array', async () => {
    const { first } = await twoAttempts(() => [{ inner: { zz: 1, y: 2 } }]);
    const [row] = first as readonly { inner: unknown }[];
    expect(orderOf(row?.inner)).toEqual(['y', 'zz']);
  });

  test('a __proto__ key stays data', async () => {
    const { first } = await twoAttempts(() => JSON.parse('{"__proto__":{"polluted":1},"a":1}'));
    expect(Object.getOwnPropertyNames(first)).toEqual(['a', '__proto__']);
    expect((first as { polluted?: unknown }).polluted).toBeUndefined();
  });
});

describe('a step output past its byte ceiling', () => {
  const KIB = 1_024;
  const ofKiB = (kib: number): string => 'x'.repeat(kib * KIB - 2); // the quotes are two bytes
  afterEach(() => mock.restore());

  test('the default 256 KiB warns once per job and step, with the code, and still stores', async () => {
    expect(STEP_OUTPUT_MAX_BYTES).toBe(256 * KIB);
    const warn = spyOn(logger, 'warn').mockImplementation(() => undefined);
    const store = memoryStepStore();
    // Its own job name per evaluation: the once-per-job-and-step memo is the PROCESS's, and a rerun
    // of this file (`--rerun-each`) is the same process.
    const jobName = `warned-${crypto.randomUUID()}`;
    const runner = stepRunner({ runId: 'r', jobName, store });
    expect(await runner.step.run('small', () => ofKiB(200))).toHaveLength(200 * KIB - 2);
    expect(warn).not.toHaveBeenCalled();

    expect(await runner.step.run('large', () => ofKiB(300))).toHaveLength(300 * KIB - 2);
    expect((await store.get('r', 'large'))?.status).toBe('completed');
    expect(warn).toHaveBeenCalledTimes(1);
    const [event, fields] = warn.mock.calls[0] ?? [];
    expect(event).toBe('jobs.step.output-too-large');
    expect(fields).toMatchObject({
      code: 'X_STEP_OUTPUT_TOO_LARGE',
      step: 'large',
      bytes: 300 * KIB,
    });
    expect(String((fields as { fix?: unknown }).fix)).toContain('stepOutputMax');

    // The same job and step on the next run: warned already, not again.
    const next = stepRunner({ runId: 'r2', jobName, store });
    await next.step.run('large', () => ofKiB(300));
    expect(warn).toHaveBeenCalledTimes(1);
  });

  test('a declared ceiling refuses, terminally, and stores nothing', async () => {
    const store = memoryStepStore();
    const runner = stepRunner({ runId: 'r', jobName: 'j', store, stepOutputMaxBytes: 256 * KIB });
    expect(await runner.step.run('small', () => ofKiB(200))).toHaveLength(200 * KIB - 2);

    const thrown = await runner.step
      .run('large', () => ofKiB(300))
      .catch((error: unknown) => error);
    if (!isUltimateError(thrown)) return expect.unreachable('expected a coded refusal');
    expect(thrown.code).toBe('X_STEP_OUTPUT_TOO_LARGE');
    expect(thrown.cause).toContain('"large"');
    expect(thrown.cause).toContain(String(300 * KIB));
    expect(thrown.fix).toContain('stepOutputMax');
    expect(nextRetryForError(DEFAULT_RETRY, 1, thrown).stoppedBy).toBe('terminal');
    expect((await store.get('r', 'large'))?.status).toBe('failed');
  });

  test('bytes, not characters: a multi-byte output is measured as UTF-8', async () => {
    const runner = stepRunner({
      runId: 'r',
      jobName: 'j',
      store: memoryStepStore(),
      stepOutputMaxBytes: 300,
    });
    // 100 characters of 4 bytes each: 402 bytes stored, over a 300-byte ceiling.
    const limited = stepRunner({
      runId: 'r2',
      jobName: 'j',
      store: memoryStepStore(),
      stepOutputMaxBytes: 300,
    });
    // 50 of them: 202 bytes, under the same ceiling.
    expect(await runner.step.run('s', () => '😀'.repeat(50))).toHaveLength(100);
    const thrown = await limited.step
      .run('s', () => '😀'.repeat(100))
      .catch((error: unknown) => error);
    if (!isUltimateError(thrown)) return expect.unreachable('expected a coded refusal');
    expect(thrown.code).toBe('X_STEP_OUTPUT_TOO_LARGE');
  });

  test('a ceiling that is not a whole number of bytes is refused where it is passed', () => {
    expect(() =>
      stepRunner({ runId: 'r', jobName: 'j', store: memoryStepStore(), stepOutputMaxBytes: 0.5 }),
    ).toThrow('stepOutputMaxBytes');
  });
});
