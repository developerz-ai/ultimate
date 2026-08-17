// Single responsibility: the currency CHECK this package emits accepts, on a real server, exactly
// what `@ultimat3/schema`'s `isCurrencyCode` accepts in TypeScript.
//
// The bound has one declaration (`CURRENCY_CODE_PATTERN`) and three projections: the predicate,
// the JSON Schema `pattern`, and this CHECK. `columns.test.ts` proves the CHECK still carries that
// pattern — but a string is not a meaning, and the SQL half is the only projection evaluated by
// something that is not JavaScript. Postgres regexes are POSIX ARE, not ECMAScript: `$`, a
// character-class range and a bounded repetition are the intersection this pattern deliberately
// stays inside, and nothing but a server can say the intersection still holds.
//
// Skips unless `TEST_DATABASE_URL` is set, exactly like `pg-driver.live.test.ts`; CI's `postgres`
// service container sets it.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createPostgresClient, type PostgresClient, raw, sql, sqlState } from '@ultimat3/db';
import { isCurrencyCode } from '@ultimat3/schema';
import { currencyCheck } from './columns';

const adminUrl = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof adminUrl === 'string' && adminUrl.length > 0;

const TABLE = 'currency_check_probe';
const DROP = `drop table if exists ${TABLE}`;

/** `check_violation` — the only refusal that means the CHECK decided. */
const CHECK_VIOLATION = '23514';

/** The same corpus `columns.test.ts` and `@ultimat3/schema`'s `money-value.test.ts` run. */
const CURRENCY_CASES: readonly string[] = [
  'USD',
  'EUR',
  'XBT',
  'AAA',
  'ZZZ',
  'usd',
  'UsD',
  'US',
  'USDD',
  'US1',
  'US_',
  'US ',
  ' US',
  '',
  'USD\n',
];

describe.skipIf(!hasPostgres)('live · postgres · the currency CHECK', () => {
  let client: PostgresClient;

  beforeAll(async () => {
    client = createPostgresClient({ url: adminUrl ?? '' });
    await client.execute(raw(DROP));
    // `text`, not the `char(3)` the money column declares: on a `char(3)` a four-character code is
    // refused for its WIDTH (22001) and a two-character one is space-padded into a value the CHECK
    // never sees as written, so the width would answer for half the corpus and the pattern would
    // go untested on exactly the cases it exists to refuse.
    await client.execute(
      raw(
        `create table ${TABLE} (code text, constraint code_shape check (${currencyCheck('code')}))`,
      ),
    );
  });

  afterAll(async () => {
    await client.execute(raw(DROP));
    await client.close();
  });

  test('accepts exactly the codes isCurrencyCode accepts', async () => {
    for (const value of CURRENCY_CASES) {
      const state = await client
        .execute(sql`insert into currency_check_probe (code) values (${value})`)
        .then(
          () => undefined,
          (error: unknown) => sqlState(error) ?? 'no-sqlstate',
        );
      // Not merely "the insert failed": a typo in the DDL would refuse every row and read as a
      // CHECK that agrees with the predicate on every rejected case.
      const stored = state === undefined;
      expect([value, stored, stored ? undefined : state]).toEqual([
        value,
        isCurrencyCode(value),
        isCurrencyCode(value) ? undefined : CHECK_VIOLATION,
      ]);
    }
  });
});
