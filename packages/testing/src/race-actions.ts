// Concurrency helpers for an app test: `raceActions` fires calls at once, round after round, and
// reports every deadlock or lost serialization race (SQLSTATE 40P01 / 40001, both
// `X_DB_SERIALIZATION_FAILURE`); `expectPartial` states a `decide()` answer in one call.

import { expect } from 'bun:test';
import { assertCoded } from '@ultimat3/core';
import { DB_SQLSTATE_CODES, sqlState } from '@ultimat3/db';

export interface RaceOptions {
  /** How many times the whole set is fired. Required: how hard to race is the test's decision. */
  readonly rounds: number;
}

export interface SerializationFailure {
  readonly round: number;
  readonly call: number;
  readonly code: 'X_DB_SERIALIZATION_FAILURE';
  /** The SQLSTATE: `40P01` (deadlock) or `40001` (serialization failure). */
  readonly sqlState: string;
  readonly error: unknown;
}

export interface RaceReport<T> {
  readonly rounds: number;
  /** Per round, per call, in the order the calls were given. */
  readonly settled: readonly (readonly PromiseSettledResult<T>[])[];
  /** Every rejection that is a lost race. Empty is the property the test asserts. */
  readonly serializationFailures: readonly SerializationFailure[];
}

function lostRace(error: unknown): string | undefined {
  const state = sqlState(error);
  return state !== undefined && DB_SQLSTATE_CODES[state] === 'X_DB_SERIALIZATION_FAILURE'
    ? state
    : undefined;
}

/**
 * Run `calls` concurrently, `rounds` times, each round after the last has settled. Never throws
 * for a call's own failure: a rejection is in `settled`, and a lost race is also listed in
 * `serializationFailures`, so a test can assert it is empty (or, for a retry test, not).
 */
export async function raceActions<T>(
  calls: readonly (() => Promise<T>)[],
  options: RaceOptions,
): Promise<RaceReport<T>> {
  assertCoded(
    calls.length >= 2,
    'X_INVARIANT',
    `raceActions got ${String(calls.length)} call(s): one call races nothing, so a green result would prove nothing`,
    'raceActions([() => a(), () => b()], { rounds: 20 })   # at least two calls',
  );
  assertCoded(
    Number.isInteger(options.rounds) && options.rounds >= 1,
    'X_INVARIANT',
    'raceActions({ rounds }) needs a whole number of rounds, 1 or more',
    'raceActions([() => a(), () => b()], { rounds: 20 })',
  );
  const settled: PromiseSettledResult<T>[][] = [];
  const serializationFailures: SerializationFailure[] = [];
  for (let round = 0; round < options.rounds; round += 1) {
    const results = await Promise.allSettled(calls.map((call) => Promise.try(call)));
    results.forEach((result, call) => {
      if (result.status !== 'rejected') return;
      const state = lostRace(result.reason);
      if (state === undefined) return;
      serializationFailures.push({
        round,
        call,
        code: 'X_DB_SERIALIZATION_FAILURE',
        sqlState: state,
        error: result.reason,
      });
    });
    settled.push(results);
  }
  return { rounds: options.rounds, settled, serializationFailures };
}

/** The shape of an action's `decide()` answer, typed structurally: no import from `action`. */
export interface PartialAnswer<TRow> {
  readonly allowed: readonly TRow[];
  readonly denied: readonly {
    readonly row: TRow;
    readonly code: string;
    readonly reason: string;
  }[];
}

export interface PartialExpectation<TRow> {
  readonly allowed: readonly TRow[];
  /** A denied row, and optionally the `code` / `reason` it must carry. */
  readonly denied: readonly {
    readonly row: TRow;
    readonly code?: string | undefined;
    readonly reason?: string | undefined;
  }[];
}

/** The answer's allowed rows, and its denied rows with the code and reason stated, are exactly these. */
export function expectPartial<TRow>(
  result: PartialAnswer<TRow>,
  expected: PartialExpectation<TRow>,
): void {
  expect(result.allowed).toEqual(expected.allowed as TRow[]);
  expect(result.denied.map((d) => d.row)).toEqual(expected.denied.map((d) => d.row));
  expected.denied.forEach((want, at) => {
    const got = result.denied[at];
    if (want.code !== undefined) expect(got?.code).toBe(want.code);
    if (want.reason !== undefined) expect(got?.reason).toBe(want.reason);
  });
}
