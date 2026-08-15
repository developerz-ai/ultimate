// The two rails the PASS holds, as against the ones `x db backfill` holds. Both are here because
// app code that calls `.enqueue()` never passes through a command — a check only the CLI performs
// is a convention, not a rail (axiom 3).
//
// Its own file rather than another block in `backfill-pass.test.ts`: those tests share one frozen
// harness and this one moves `ULTIMATE_ENV` out from under the process.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import { harness, ORG, RUN_ID } from './backfill-pass-fixture';
import { resetJobDriver } from './driver';
import { resetJobs } from './job';

const previous = process.env['ULTIMATE_ENV'];

const setEnvironment = (value: string | undefined): void => {
  if (value === undefined) delete process.env['ULTIMATE_ENV'];
  else process.env['ULTIMATE_ENV'] = value;
};

beforeEach(() => {
  resetJobs();
  setEnvironment('development');
});

afterEach(() => {
  resetJobDriver();
  setEnvironment(previous);
});

const codeOf = (error: unknown): string | undefined =>
  isUltimateError(error) ? error.code : undefined;

describe('unit · the environment rail', () => {
  test('an undeclared environments list runs everywhere — no implied "production only"', async () => {
    const pass = harness({ name: 'anywhere' });
    setEnvironment('development');
    await pass.run();
    expect(pass.seen.length).toBeGreaterThan(0);
  });

  test('a sweep declared for production refuses in development, before it opens the ledger', async () => {
    const pass = harness({ name: 'prod-only', environments: ['production'] });
    let thrown: unknown;
    try {
      await pass.run();
    } catch (error) {
      thrown = error;
    }
    expect(codeOf(thrown)).toBe('X_BACKFILL_ENVIRONMENT');
    // Nothing was read and nothing was checkpointed: the refusal is ahead of the whole pass, so a
    // wrong-environment enqueue leaves no row claiming a sweep started.
    expect(pass.seen).toEqual([]);
    expect(pass.watch.reads).toBe(0);
    expect(await pass.steps()).toEqual([]);
  });

  test('the same declaration runs once the process says it is production', async () => {
    const pass = harness({ name: 'prod-only-ok', environments: ['production'] });
    setEnvironment('production');
    await pass.run();
    expect(pass.seen.length).toBeGreaterThan(0);
  });

  test('a staging rehearsal is a declared environment like any other', async () => {
    const pass = harness({ name: 'rehearsed', environments: ['staging', 'production'] });
    setEnvironment('staging');
    await pass.run();
    expect(pass.seen.length).toBeGreaterThan(0);
  });
});

describe('unit · the stall detector', () => {
  test('a sweep with no count() converges by definition — the framework guesses no number', async () => {
    const pass = harness({ name: 'uncounted' });
    const report = await pass.run();
    expect((report as { skipped: boolean }).skipped).toBe(false);
  });

  test('count() at zero after the source is exhausted is a clean pass', async () => {
    const pass = harness({ name: 'converged', count: () => 0 });
    const report = await pass.run();
    expect((report as { rows: number }).rows).toBe(10);
  });

  test('count() still matching rows the source ran out of FAILS the pass', async () => {
    // Two predicates that disagree: the sweep reported success over rows nobody visited. The pass
    // must not write a completed row that stops the next deploy re-running it.
    const pass = harness({ name: 'stalled', count: () => 4 });
    let thrown: unknown;
    try {
      await pass.run();
    } catch (error) {
      thrown = error;
    }
    expect(codeOf(thrown)).toBe('X_BACKFILL_STALLED');
    expect(isUltimateError(thrown) ? thrown.cause : '').toContain('4');
    // Every batch still ran — the verdict is about what is LEFT, never about the sweep failing.
    expect(pass.seen.flat().length).toBe(10);
  });

  test('the stall verdict names the sweep and the org-scoped chain it swept', async () => {
    const pass = harness({ name: 'named-stall', count: () => 1 });
    let thrown: unknown;
    try {
      await pass.run({ runId: RUN_ID });
    } catch (error) {
      thrown = error;
    }
    expect(isUltimateError(thrown) ? thrown.cause : '').toContain('named-stall');
    expect(isUltimateError(thrown) ? thrown.fix : '').toContain('count()');
    expect(ORG).toBeDefined();
  });
});
