// Single responsibility: the CHECK an `iff` of two null-tests generates decides the same rows on a
// real server that `holds` decides in TypeScript — and the choice of `=` over `is not distinct
// from` is measured here rather than argued.
//
// `expr.test.ts` proves the emitted TEXT. Only a server can say that `(a) = (b)` refuses the two
// incoherent rows, that it PASSES when an operand is NULL, and that the total spelling would have
// refused a row the app accepted. Skips unless `TEST_DATABASE_URL` is set.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  createPostgresClient,
  generateMigration,
  type PostgresClient,
  raw,
  sql,
  sqlState,
  statementsOf,
} from '@ultimat3/db';
import { enumerated, text, timestamp, uuid } from './columns';
import { entity } from './entity';
import { iff } from './expr';
import { invariant as named } from './invariants';
import { clearRegistry } from './registry';

const adminUrl = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof adminUrl === 'string' && adminUrl.length > 0;
const CHECK_VIOLATION = '23514';

/** `examples/dummy`'s rule, in the language it could not be written in until now. */
const posts = entity('null_probe_posts', {
  columns: {
    id: uuid().primaryKey(),
    status: enumerated(['draft', 'published']).default('draft'),
    publishedAt: timestamp().nullable(),
  },
  invariants: (c) => [
    named('publish_coherent', iff(c.status.eq('published'), c.publishedAt.isNotNull())),
  ],
});

/**
 * The same shape with a NULLABLE operand on the left, so the permissive direction is measured on a
 * real table rather than asserted from the docs. Nothing in the reference app looks like this; it
 * exists to pin what happens when it does.
 */
const partial = entity('null_probe_partial', {
  columns: {
    id: uuid().primaryKey(),
    label: text({ max: 20 }).nullable(),
    mark: timestamp().nullable(),
  },
  invariants: (c) => [named('partial_coherent', iff(c.label.eq('on'), c.mark.isNotNull()))],
});

const DROP = 'drop table if exists "null_probe_posts", "null_probe_partial" cascade';

describe.skipIf(!hasPostgres)('live · postgres · iff over a null test becomes a CHECK', () => {
  let client: PostgresClient;

  beforeAll(async () => {
    client = createPostgresClient({ url: adminUrl ?? '' });
    await client.execute(raw(DROP));
    const migration = generateMigration({
      entities: [posts.$describe(), partial.$describe()],
      name: 'invariant null probe',
      now: new Date('2026-08-25T00:00:00.000Z'),
    });
    for (const statement of statementsOf(migration.up)) await client.execute(raw(statement));
  });

  afterAll(async () => {
    await client.execute(raw(DROP));
    await client.close();
  });

  const storePost = (status: string, at: string | null): Promise<string | undefined> =>
    client
      .execute(
        sql`insert into "null_probe_posts" (id, status, published_at) values (gen_random_uuid(), ${status}, ${at})`,
      )
      .then(
        () => undefined,
        (error: unknown) => sqlState(error) ?? 'no-sqlstate',
      );

  const AT = '2026-08-25T00:00:00.000Z';

  /**
   * The load-bearing one, in the shape the slug corpus uses: both verdicts asserted TOGETHER, so a
   * CHECK that refuses everything reads as a failure rather than as agreement on the refused half.
   */
  test('the CHECK stores exactly the coherent rows and refuses each incoherent one with 23514', async () => {
    const corpus: readonly (readonly [string, 'draft' | 'published', string | null])[] = [
      ['published with an instant', 'published', AT],
      ['draft with no instant', 'draft', null],
      ['published with NO instant', 'published', null],
      ['draft WITH an instant', 'draft', AT],
    ];
    for (const [label, status, at] of corpus) {
      const state = await storePost(status, at);
      const accepted = posts.$invariants[0]?.holds({
        id: 'x',
        status,
        publishedAt: at === null ? null : new Date(at),
      });
      expect([label, state === undefined, state]).toEqual([
        label,
        accepted,
        accepted ? undefined : CHECK_VIOLATION,
      ]);
    }
  });

  test('the emitted predicate is the one the hand-written migration already holds', () => {
    expect(posts.$invariants[0]?.sql).toBe("(status = 'published') = (published_at is not null)");
    expect(posts.$invariants[0]?.kind).toBe('check');
  });

  test('a row that never NAMES published_at is judged as NULL by both halves', async () => {
    // The column is left out of the statement entirely, which is the case `expr.test.ts` pins on
    // the app side as an ABSENT key: the table stores NULL either way, so the CHECK must reach the
    // same verdict as `holds` does for a row whose key was never typed.
    const omitted = await client
      .execute(sql`insert into "null_probe_posts" (id, status) values (gen_random_uuid(), 'draft')`)
      .then(
        () => undefined,
        (error: unknown) => sqlState(error) ?? 'no-sqlstate',
      );
    expect(omitted).toBeUndefined();
    const refused = await client
      .execute(
        sql`insert into "null_probe_posts" (id, status) values (gen_random_uuid(), 'published')`,
      )
      .then(
        () => undefined,
        (error: unknown) => sqlState(error) ?? 'no-sqlstate',
      );
    expect(refused).toBe(CHECK_VIOLATION);
  });

  /**
   * The measurement behind `=`. With a NULL operand the emitted CHECK PASSES the row while
   * TypeScript refuses it — the app is the stricter half, so nothing ever reaches the server that
   * the CHECK would have refused. The total spelling inverts exactly that, which the next test
   * measures on the same server.
   */
  test('a NULL operand leaves the CHECK permissive, and the app refuses the row first', async () => {
    const stored = await client
      .execute(
        sql`insert into "null_probe_partial" (id, label, mark) values (gen_random_uuid(), null, ${AT})`,
      )
      .then(
        () => undefined,
        (error: unknown) => sqlState(error) ?? 'no-sqlstate',
      );
    expect(stored).toBeUndefined();
    expect(partial.$invariants[0]?.holds({ id: 'x', label: null, mark: new Date(AT) })).toBe(false);
  });

  test('is not distinct from would refuse a row TypeScript accepts — the dangerous direction', async () => {
    const answer = async (expression: string): Promise<boolean | null> => {
      const rows = await client.query<{ m: boolean | null }>(sql`select (${raw(expression)}) as m`);
      return rows[0]?.m ?? null;
    };
    // `label` NULL and `mark` NULL: TypeScript reads both predicates as false, so both-or-neither
    // ACCEPTS the row.
    expect(partial.$invariants[0]?.holds({ id: 'x', label: null, mark: null })).toBe(true);
    // `=` agrees by passing on NULL; `is not distinct from` answers false and would refuse it,
    // reaching the caller as a raw 23514 in place of X_INVARIANT_VIOLATED.
    expect(await answer("(null::text = 'on') = (null::timestamptz is not null)")).toBeNull();
    expect(
      await answer("(null::text = 'on') is not distinct from (null::timestamptz is not null)"),
    ).toBe(false);
    // And with both operands total the two spellings are the same predicate, which is why the
    // choice costs the reference app nothing.
    for (const [a, b] of [
      ['true', 'true'],
      ['true', 'false'],
      ['false', 'true'],
      ['false', 'false'],
    ] as const) {
      expect([a, b, await answer(`(${a}) = (${b})`)]).toEqual([
        a,
        b,
        await answer(`(${a}) is not distinct from (${b})`),
      ]);
    }
  });
});

// Outside the block above and unconditional: bun runs no hook inside a skipped `describe`, and the
// registry is process-wide. `live-registry-cleanup.test.ts` is the rule that keeps it here.
afterAll(() => {
  clearRegistry();
});
