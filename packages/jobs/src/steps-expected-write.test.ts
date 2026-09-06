// The framework's own step write, as the N+1 detector sees it. `x dev`'s ledger judges a
// request's statements by `StatementEvent.expected` — `if (event.expected !== undefined) return;`
// in `@ultimat3/cli`'s `dev-n-plus-one.ts` — and every job of five or more steps tripped it:
//
//   X_N_PLUS_ONE_WRITE: insert into x_job_steps (run_id, name, status, output, …) on conflict
//   (run_id, name) do update … ran 5 times in one request — one write per row
//
// with a `fix:` naming `expectedQueryLoop`, which the app could not apply to a statement it never
// wrote. One statement per step IS the design (`steps.ts`), so the statement has to arrive at the
// funnel carrying the reason. Driven through the REAL funnel — `@ultimat3/db`'s client over a
// fake `Bun.SQL`, the way `client-observer.test.ts` does — because a fake executor reading the
// reason back would be asserting about itself, not about what the ledger receives.

import { afterEach, describe, expect, test } from 'bun:test';
import type { DbClient, SqlFragment, StatementEvent } from '@ultimat3/db';
import { createPostgresClient, setStatementObserver } from '@ultimat3/db';
import type { PgExecutor } from './driver-pg';
import { createPgDriver } from './driver-pg';
import { SQL_STEP_LIST, SQL_STEP_PUT } from './driver-pg-sql';
import { JobTimeoutError } from './errors';
import { createStepRunner } from './steps';

const TEST_URL = 'postgres://app@127.0.0.1:5432/ultimate_test';

// `Bun.SQL` is writable but not configurable, so the seam is assignment plus an afterEach restore.
const host = globalThis as unknown as { Bun: { SQL: unknown } };
const realBunSql = host.Bun.SQL;

afterEach(() => {
  host.Bun.SQL = realBunSql;
  // Process-wide, so a test that installs one and leaves it behind observes every later test.
  setStatementObserver(undefined);
});

/** Answers no rows to everything; what the statements were is the observer's answer. */
function installFakeSql(): void {
  host.Bun.SQL = class {
    async unsafe(): Promise<unknown> {
      return [];
    }
    async reserve(): Promise<unknown> {
      return { unsafe: async (): Promise<unknown> => [], release: (): void => undefined };
    }
    async close(): Promise<void> {}
  };
}

/** `@ultimat3/cli`'s `pgExecutorFor`: where the queue's statements enter the funnel in a real boot. */
const executorOver = (client: DbClient): PgExecutor => ({
  query: <R>(text: string, values: readonly unknown[]): Promise<readonly R[]> =>
    client.query<R>({ text, values } satisfies SqlFragment),
});

describe('the step write and the N+1 detector', () => {
  test('every SQL_STEP_PUT reaches the funnel expected, and nothing else does', async () => {
    const seen: StatementEvent[] = [];
    setStatementObserver({
      onStatement(event: StatementEvent): void {
        seen.push(event);
      },
    });
    installFakeSql();
    const driver = createPgDriver({
      executor: executorOver(createPostgresClient({ url: TEST_URL })),
    });
    const runner = createStepRunner({ runId: 'run-n1', jobName: 'fiveSteps', store: driver.steps });

    // Five completions — the threshold — and one failure, which is written on the way out.
    for (const name of ['a', 'b', 'c', 'd', 'e']) {
      await runner.step.run(name, () => name);
    }
    await expect(
      runner.step.run('f', () => {
        throw new JobTimeoutError({ job: 'fiveSteps', step: 'f', timeoutMs: 1 });
      }),
    ).rejects.toThrow('fiveSteps');

    const writes = seen.filter((event) => event.text === SQL_STEP_PUT);
    expect(writes.length).toBe(6);
    for (const event of writes) {
      expect(event.expected).toMatch(/one statement per step/);
    }

    // The scope ends with the write: the one hydrating read is judged as any statement is, and
    // nothing outside the six writes carries the reason.
    const reads = seen.filter((event) => event.text === SQL_STEP_LIST);
    expect(reads.length).toBe(1);
    expect(reads[0]?.expected).toBeUndefined();
    expect(seen.filter((event) => event.expected !== undefined).length).toBe(writes.length);
  });
});
