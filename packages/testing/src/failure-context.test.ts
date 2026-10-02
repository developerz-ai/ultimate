// A failed test carries the context it needs to be debugged where it failed: under e2e, the last
// lines the spawned app logged — so a live-path bug is not a second run of `x dev` by hand.

import { afterEach, describe, expect, test } from 'bun:test';
import { appLogTail, setFailureContext, withFailureContext } from './failure-context';
import { runWithFixtures } from './fixtures';

/** Stands in for whatever an assertion library or the app throws: input here, never a verdict. */
class AppRefusal extends Error {}

afterEach(() => setFailureContext(undefined));

const failureOf = async (body: () => Promise<void>): Promise<unknown> =>
  runWithFixtures(body).then(
    () => expect.unreachable('the body threw, so the run must reject'),
    (error: unknown) => error,
  );

describe('unit · a failed test carries the spawned app’s log', () => {
  test('the failure message ends with the app log tail, under a header naming it', async () => {
    setFailureContext(() => 'boot\nX_LIVE_QUERY_UNKNOWN: liveRunEvents\n');
    const error = await failureOf(async () => {
      expect(1).toBe(2);
    });
    const message = (error as Error).message;
    expect(message).toContain('expect(received).toBe(expected)');
    expect(message).toContain('the e2e app logged, last 2 line(s):');
    expect(message.trimEnd().endsWith('X_LIVE_QUERY_UNKNOWN: liveRunEvents')).toBe(true);
  });

  test('a passing test is untouched, and so is a failure with no context installed', async () => {
    setFailureContext(() => 'noise');
    await runWithFixtures(async () => undefined);
    setFailureContext(undefined);
    const error = await failureOf(async () => {
      throw new AppRefusal('as written');
    });
    expect((error as Error).message).toBe('as written');
  });

  test('bounded: the last lines only, however long the app has been talking', () => {
    const log = Array.from({ length: 500 }, (_, index) => `line ${String(index)}`).join('\n');
    const tail = appLogTail(log);
    expect(tail.split('\n')).toHaveLength(40);
    expect(tail.endsWith('line 499')).toBe(true);
    expect(appLogTail('x'.repeat(50_000)).length).toBeLessThanOrEqual(4_000);
  });

  test('a thrown non-Error is passed through as it was', () => {
    setFailureContext(() => 'log');
    expect(withFailureContext('a string')).toBe('a string');
  });
});
