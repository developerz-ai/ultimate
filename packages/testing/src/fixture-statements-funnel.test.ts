// The half a synthetic event cannot prove: that the throw actually reaches the caller. Statements
// go through `@ultimat3/db`'s real pooled funnel here — a fake `Bun.SQL` under a real
// `createPostgresClient` — so the loop's fifth `await client.query(...)` is what rejects, which is
// the whole promise of strict mode. The other half is the fix line: with a schema in the registry,
// the failure names the `preload()` that ends the loop rather than the generic `in` form.

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import {
  createPostgresClient,
  expectedQueryLoop,
  setStatementObserver,
  sql,
  withStatementAttribution,
} from '@ultimat3/db';
import { clearRegistry, entity, N_PLUS_ONE_THRESHOLD, text, uuid } from '@ultimat3/entity';
import { createTestStatements, type TestStatements } from './fixture-statements';

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
  setStatementObserver(undefined);
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
  const client = createPostgresClient({ url: TEST_URL });
  for (let sent = 0; sent < times; sent += 1) {
    await client.query(sql`select "id" from "n1s_members" where "id" = ${sent}`);
  }
  expect(statements.count()).toBe(times);
}

describe('unit · the loop fails at the statement that crossed the threshold', () => {
  test('the first statements resolve and the one past the threshold rejects', async () => {
    const pool = installFakeSql();
    using statements = await createTestStatements();
    const client = createPostgresClient({ url: TEST_URL });
    const one = (): Promise<unknown> =>
      client.query(sql`select "id" from "n1s_members" where "id" = ${1}`);

    for (let sent = 0; sent < N_PLUS_ONE_THRESHOLD - 1; sent += 1) {
      expect(await rejection(one)).toBeUndefined();
    }
    const error = await rejection(one);

    expect(error?.code).toBe('X_N_PLUS_ONE_QUERY');
    // The statement itself still went out: the observer runs after it settled, so the row a caller
    // was given is real and the failure is about the loop, not about this one read.
    expect(pool.statements).toHaveLength(N_PLUS_ONE_THRESHOLD);
    expect(statements.count()).toBe(N_PLUS_ONE_THRESHOLD);
  });

  test('a loop declared with expectedQueryLoop runs to the end', async () => {
    installFakeSql();
    using statements = await createTestStatements();

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
    using statements = await createTestStatements();

    const error = await rejection(() =>
      withStatementAttribution('n1s_members', 'findById', () =>
        loop(N_PLUS_ONE_THRESHOLD, statements),
      ),
    );

    expect(error?.cause).toContain('n1s_members.findById');
    expect(statements.count('n1s_members.findById')).toBe(N_PLUS_ONE_THRESHOLD);
  });

  test('a hand-written loop names its own text, since no chain compiled it', async () => {
    installFakeSql();
    using statements = await createTestStatements();

    const error = await rejection(() => loop(N_PLUS_ONE_THRESHOLD, statements));

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
    using statements = await createTestStatements();

    const error = await rejection(() =>
      withStatementAttribution('n1s_members', 'findById', () =>
        loop(N_PLUS_ONE_THRESHOLD, statements),
      ),
    );

    expect(error?.fix).toContain("db.n1s_posts.preload('author')");
  });

  test('an entity nothing references falls back to the in form of its own statement', async () => {
    installFakeSql();
    using statements = await createTestStatements();

    const error = await rejection(() =>
      withStatementAttribution('n1s_posts', 'findById', () =>
        loop(N_PLUS_ONE_THRESHOLD, statements),
      ),
    );

    expect(error?.fix).toContain("db.n1s_posts.andWhere('id', 'in', ids).all()");
  });
});
