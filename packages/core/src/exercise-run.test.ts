// The one exercise loop both `action` and `query` adapt: its verdicts, its seed and its two
// refusals before a run — a deploy, and a write that no transaction would undo.

import { describe, expect, test } from 'bun:test';
import { isUltimateError, UltimateError } from './errors';
import type { ExerciseAttempt, ExerciseSubject } from './exercise-run';
import {
  assertExerciseScoped,
  EXERCISE_RUNS,
  exerciseDefect,
  exerciseReplay,
  runExercise,
  sealedHost,
} from './exercise-run';
import { fnv1a } from './fnv1a';

const TEST_ENV = { NODE_ENV: 'test' };
const status = (code: string): number | undefined => (code === 'X_DB_DRIFT' ? 500 : 404);

const subject = (
  attempt: (input: unknown, run: number) => ExerciseAttempt,
  overrides: Partial<ExerciseSubject> = {},
): ExerciseSubject => {
  let run = -1;
  return {
    name: 'probe',
    stoppedLabel: 'stopped before the handler',
    draw: (seed, at) => ({ seed, at }),
    accepts: () => Promise.resolve(true),
    attempt: (input) => {
      run += 1;
      return Promise.resolve(attempt(input, run));
    },
    statusOf: status,
    env: TEST_ENV,
    ...overrides,
  };
};

const refusalOf = async (run: () => Promise<unknown>): Promise<UltimateError> => {
  try {
    await run();
  } catch (error) {
    if (isUltimateError(error)) return error;
    expect.unreachable('a coded refusal');
  }
  return expect.unreachable('the exercise ran');
};

const coded = (code: string): UltimateError => new UltimateError({ code, cause: 'c', fix: 'f' });

describe('verdicts', () => {
  test('every run answered is a pass, seeded by the name', async () => {
    const seen: unknown[] = [];
    const verdict = await runExercise(
      subject((input) => {
        seen.push(input);
        return { ok: true, reached: true };
      }),
    );
    expect(verdict).toEqual({
      kind: 'pass',
      report: expect.objectContaining({ runs: EXERCISE_RUNS, reached: EXERCISE_RUNS }),
    });
    expect(seen[3]).toEqual({ seed: fnv1a('probe'), at: 3 });
  });

  test('an uncoded throw is a defect at its run, with the input it was given', async () => {
    const verdict = await runExercise(
      subject((_, run) =>
        run === 2
          ? { ok: false, reached: true, error: new TypeError('x') }
          : { ok: true, reached: true },
      ),
    );
    expect(verdict.kind).toBe('defect');
    if (verdict.kind !== 'defect') return;
    expect(verdict.run).toBe(2);
    expect(verdict.defect).toContain('threw an uncoded TypeError');
    expect(verdict.input).toEqual({ seed: fnv1a('probe'), at: 2 });
  });

  test('a coded 5xx and X_OUTPUT_INVALID are defects; a coded 4xx is a pass', () => {
    expect(exerciseDefect(coded('X_DB_DRIFT'), status)).toBe('answered X_DB_DRIFT, a 500');
    expect(exerciseDefect(coded('X_OUTPUT_INVALID'), status)).toContain('output schema rejects');
    expect(exerciseDefect(coded('X_NOT_FOUND'), status)).toBeNull();
    // A code the table has never heard of answers 500 on the wire, so it is one here.
    expect(exerciseDefect(coded('X_UNHEARD'), () => undefined)).toContain('a 500');
  });

  test('zero reached is unreached, and the outcomes say what each run hit', async () => {
    const verdict = await runExercise(
      subject(() => ({ ok: false, reached: false, error: coded('X_FORBIDDEN') })),
    );
    expect(verdict.kind).toBe('unreached');
    if (verdict.kind !== 'unreached') return;
    expect(verdict.outcomes[0]).toBe('run 0: stopped before the handler with X_FORBIDDEN');
  });

  test('a sealed network is unreached and names its host', async () => {
    const sealed = new UltimateError({
      code: 'X_TEST_NETWORK_SEALED',
      cause: 'GET https://api.example.test/v1 was not mocked',
      fix: 'mockFetch',
    });
    const verdict = await runExercise(subject(() => ({ ok: false, reached: true, error: sealed })));
    expect(verdict.kind === 'unreached' && verdict.outcomes[0]).toBe(
      'run 0: network sealed (api.example.test)',
    );
    expect(sealedHost('nothing like it')).toBe('an unnamed host');
  });

  test('every draw refused is drift; a binder sees the drawn value', async () => {
    const bound: unknown[] = [];
    const verdict = await runExercise(
      subject(() => ({ ok: true, reached: true }), {
        accepts: () => Promise.resolve(false),
        bind: (drawn) => {
          bound.push(drawn);
          return drawn;
        },
      }),
    );
    expect(verdict.kind).toBe('drift');
    expect(bound).toHaveLength(EXERCISE_RUNS);
  });

  test('the replay is this file and the test name; a name a shell would read falls back', () => {
    expect(exerciseReplay('probe', 'probe: survives')).toBe(
      "bun test packages/core/src/exercise-run.test.ts -t 'probe: survives'",
    );
    expect(exerciseReplay("it's", "it's: survives")).toBe('x verify --only contract');
  });

  test('runs outside 1..64 are refused rather than clamped', async () => {
    for (const runs of [0, 65, 1.5]) {
      const refusal = await refusalOf(() =>
        runExercise(subject(() => ({ ok: true, reached: true }), { runs })),
      );
      expect(refusal.code).toBe('X_INVARIANT');
    }
  });
});

describe('refusals before a run', () => {
  test('a deploy refuses before the first attempt: production and staging', async () => {
    for (const env of [{ ULTIMATE_ENV: 'production' }, { NODE_ENV: 'staging' }]) {
      let attempts = 0;
      const refusal = await refusalOf(() =>
        runExercise(
          subject(
            () => {
              attempts += 1;
              return { ok: true, reached: true };
            },
            { env },
          ),
        ),
      );
      expect(refusal.code).toBe('X_CONTRACT_EXERCISE_ENVIRONMENT');
      expect(refusal.fix).toContain('bun test');
      expect(attempts).toBe(0);
    }
  });

  test('development and test run', async () => {
    for (const env of [{ NODE_ENV: 'development' }, TEST_ENV]) {
      const verdict = await runExercise(subject(() => ({ ok: true, reached: true }), { env }));
      expect(verdict.kind).toBe('pass');
    }
  });

  test('no transaction to join is refused outside test: the writes would be kept', async () => {
    expect(() => assertExerciseScoped('probe', false, { NODE_ENV: 'development' })).toThrow(
      expect.objectContaining({ code: 'X_CONTRACT_EXERCISE_UNSCOPED' }),
    );
    // Under test with no client installed the store is memory: nothing durable to protect.
    expect(() => assertExerciseScoped('probe', false, TEST_ENV)).not.toThrow();
    expect(() => assertExerciseScoped('probe', true, { NODE_ENV: 'development' })).not.toThrow();
  });

  test('a write with nothing to roll it back is refused before its first attempt', async () => {
    let attempts = 0;
    const unscoped = subject(
      () => {
        attempts += 1;
        return { ok: true, reached: true };
      },
      { env: { NODE_ENV: 'development' }, scoped: false },
    );
    expect((await refusalOf(() => runExercise(unscoped))).code).toBe(
      'X_CONTRACT_EXERCISE_UNSCOPED',
    );
    expect(attempts).toBe(0);
    // A read declares no scope and runs in development as before.
    const read = subject(() => ({ ok: true, reached: true }), { env: { NODE_ENV: 'development' } });
    expect((await runExercise(read)).kind).toBe('pass');
  });
});
