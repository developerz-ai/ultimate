// The half a synthetic event cannot prove: that a real loop through `@ultimat3/db`'s pooled
// funnel — a fake `Bun.SQL` under a real `postgresClient` — reaches the verdict. The bus contains
// a subscriber's throw, so every statement resolves and the verdict is raised at the fixture's
// disposal: strict mode fails the test, never the read. The other half is the fix line: with a schema in the registry,
// the failure names the `preload()` that ends the loop rather than the generic `in` form.

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { resetInstrumentation } from '@ultimat3/core';
import { expectedQueryLoop, postgresClient, sql, withStatementAttribution } from '@ultimat3/db';
import { clearRegistry, entity, N_PLUS_ONE_THRESHOLD, text, uuid } from '@ultimat3/entity';
import { type TestStatements, testStatements } from './fixture-statements';

const TEST_URL = 'postgres://app@127.0.0.1:5432/ultimate_test';

// `Bun.SQL` is writable but not configurable, so the seam is assignment plus an afterEach restore —
// the same one `packages/db`'s own client tests use.
const host = globalThis as unknown as { Bun: { SQL: unknown } };
const realBunSql = host.Bun.SQL;

function installFakeSql(): { readonly statements: string[] } {
  const statements: string[] = [];
  host.Bun.SQL = class {
    async unsafe(statementText: string): Promise<unknown> {
      statements.push(statementText);
      return [];
    }
    async close(): Promise<void> {
      // Nothing to tear down: the pool is this class.
    }
  };
  return { statements };
}

afterEach(() => {
  host.Bun.SQL = realBunSql;
  resetInstrumentation();
});

/** The rejection, or `undefined` when the call resolved — the assertion says which we got. */
const rejection = async (
  run: () => Promise<unknown>,
): Promise<
  { readonly code?: string; readonly cause?: string; readonly fix?: string } | undefined
> =>
  run().then(
    () => undefined,
    (error: unknown) => error as { code?: string; cause?: string; fix?: string },
  );

/** One point lookup, sent `N` times — the loop every one of these tests is about. */
async function loop(times: number, statements: TestStatements): Promise<void> {
  const client = postgresClient({ url: TEST_URL });
  for (let sent = 0; sent < times; sent += 1) {
    await client.query(sql`select "id" from "n1s_members" where "id" = ${sent}`);
  }
  expect(statements.count()).toBe(times);
}

/** Disposal raises the first verdict: the code, cause and fix are read off what it threw. */
const verdictOf = (
  statements: TestStatements,
): { readonly code?: string; readonly cause?: string; readonly fix?: string } | undefined => {
  try {
    statements[Symbol.dispose]();
    return undefined;
  } catch (error) {
    return error as { code?: string; cause?: string; fix?: string };
  }
};

describe('unit · the loop runs to its end, and the verdict is raised at teardown', () => {
  test('every statement resolves; the shape that crossed the threshold is the verdict', async () => {
    const pool = installFakeSql();
    const statements = await testStatements();
    const client = postgresClient({ url: TEST_URL });
    const one = (): Promise<unknown> =>
      client.query(sql`select "id" from "n1s_members" where "id" = ${1}`);

    for (let sent = 0; sent < N_PLUS_ONE_THRESHOLD; sent += 1) {
      expect(await rejection(one)).toBeUndefined();
    }

    // The statements themselves went out and answered: the failure is about the loop.
    expect(pool.statements).toHaveLength(N_PLUS_ONE_THRESHOLD);
    expect(statements.count()).toBe(N_PLUS_ONE_THRESHOLD);
    expect(verdictOf(statements)?.code).toBe('X_N_PLUS_ONE_QUERY');
  });

  // The emit runs after the driver's `await`, where no caller frame survives; the funnel captures
  // the stack before it while the fixture holds `captureStatementStacks()`, so the verdict raised
  // at teardown still points at the loop.
  test('through the real funnel, the verdict names the function that looped', async () => {
    installFakeSql();
    const statements = await testStatements();
    async function readsEachMember(): Promise<void> {
      const client = postgresClient({ url: TEST_URL });
      for (let sent = 0; sent < N_PLUS_ONE_THRESHOLD; sent += 1) {
        await client.query(sql`select "id" from "n1s_members" where "id" = ${sent}`);
      }
    }
    await readsEachMember();

    const error = verdictOf(statements) as { readonly stack?: string } | undefined;
    expect(error?.stack).toContain('readsEachMember');
    expect(error?.stack).toContain('fixture-statements-funnel.test.ts:');
    expect(error?.stack).not.toContain('fixture-statements.ts:');
  });

  test('a loop declared with expectedQueryLoop runs to the end', async () => {
    installFakeSql();
    using statements = await testStatements();

    const error = await rejection(() =>
      expectedQueryLoop('one lookup per row is optimal here', () =>
        loop(N_PLUS_ONE_THRESHOLD * 2, statements),
      ),
    );

    expect(error).toBeUndefined();
    expect(statements.count()).toBe(N_PLUS_ONE_THRESHOLD * 2);
  });

  test('an attributed loop is reported as the repository call, not as its SQL', async () => {
    installFakeSql();
    const statements = await testStatements();

    await withStatementAttribution('n1s_members', 'findById', () =>
      loop(N_PLUS_ONE_THRESHOLD, statements),
    );
    const error = verdictOf(statements);

    expect(error?.cause).toContain('n1s_members.findById');
    expect(statements.count('n1s_members.findById')).toBe(N_PLUS_ONE_THRESHOLD);
  });

  test('a hand-written loop names its own text, since no chain compiled it', async () => {
    installFakeSql();
    const statements = await testStatements();

    await loop(N_PLUS_ONE_THRESHOLD, statements);
    const error = verdictOf(statements);

    expect(error?.code).toBe('X_N_PLUS_ONE_QUERY');
    expect(error?.cause).toContain('select "id" from "n1s_members" where "id" = $1');
  });
});

describe('unit · the fix is the one the schema already declared', () => {
  const members = entity('n1s_members', {
    columns: { id: uuid().primaryKey(), email: text({ max: 120 }) },
  });

  beforeAll(() => {
    // Registered here rather than at module scope so the entity below is what puts the edge in the
    // map: `relationMap()` derives `posts.author` from this `references()` and nothing else.
    entity('n1s_posts', {
      columns: {
        id: uuid().primaryKey(),
        authorId: uuid().references(() => members.id),
        title: text({ max: 120 }),
      },
    });
  });

  afterAll(() => {
    // The registry is process-global: a leaked entity breaks an unrelated package's tests.
    clearRegistry();
  });

  test('a repeated findById on a referenced entity earns the preload that ends it', async () => {
    installFakeSql();
    const statements = await testStatements();

    await withStatementAttribution('n1s_members', 'findById', () =>
      loop(N_PLUS_ONE_THRESHOLD, statements),
    );
    const error = verdictOf(statements);

    expect(error?.fix).toContain("db.n1s_posts.preload('author')");
  });

  test('an entity nothing references falls back to the in form of its own statement', async () => {
    installFakeSql();
    const statements = await testStatements();

    await withStatementAttribution('n1s_posts', 'findById', () =>
      loop(N_PLUS_ONE_THRESHOLD, statements),
    );
    const error = verdictOf(statements);

    expect(error?.fix).toContain("db.n1s_posts.andWhere('id', 'in', ids).all()");
  });
});
