// The CHECK a value rule's migration emits, asked directly with a raw statement on the embedded
// Postgres: it refuses what the app's `$assert` refuses. What the app and both drivers answer for
// the same rows is `@ultimat3/testing`'s `entityDriverConformance`; the server twin is
// `pg-invariant-value.live.test.ts`.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  generateMigration,
  pgliteClient,
  raw,
  setDbClient,
  sqlState,
  statementsOf,
} from '@ultimat3/db';
import { text, url, uuid } from './columns';
import { bigint, decimal } from './columns-data';
import { entity } from './entity';
import { invariant } from './invariants';
import { clearRegistry } from './registry';

const PGLITE_BOOT_MS = 30_000;
const CHECK_VIOLATION = '23514';

const ledgers = entity('ip_ledgers', {
  columns: {
    id: uuid().primaryKey(),
    total: bigint(),
    rate: decimal({ precision: 8, scale: 2 }),
    share: decimal({ precision: 2, scale: 2 }).nullable(),
    code: text({ max: 20 }),
    href: url().nullable(),
  },
  invariants: (c) => [
    invariant('total_non_negative', c.total.atLeast(0)),
    invariant('rate_fixed', c.rate.eq(1.5)),
    invariant('code_is_x', c.code.trimmed().eq('x')),
  ],
});

const client = pgliteClient();

beforeAll(async () => {
  setDbClient(client);
  const migration = generateMigration({
    entities: [ledgers.$describe()],
    name: 'invariant parity',
    now: new Date('2026-10-02T00:00:00.000Z'),
  });
  for (const statement of statementsOf(migration.up)) await client.execute(raw(statement));
}, PGLITE_BOOT_MS);

beforeEach(async () => {
  await client.execute(raw('delete from "ip_ledgers"'));
});

afterAll(async () => {
  setDbClient(undefined);
  await client.close();
  clearRegistry();
});

/** The CHECK alone, with no app in front of it: `'ok'`, or the SQLSTATE it refused with. */
const check = async (total: string, rate: string, code: string): Promise<string> => {
  try {
    await client.execute(
      raw(
        `insert into "ip_ledgers" (id, total, rate, code) values (gen_random_uuid(), ${total}, ${rate}, ${code})`,
      ),
    );
    return 'ok';
  } catch (error) {
    return sqlState(error) ?? `no sqlstate: ${String(error)}`;
  }
};

describe('the CHECK agrees with the rule', () => {
  test("'5' is at least 0 and '1.50' equals 1.5", async () => {
    expect(await check('5', '1.50', "'x'")).toBe('ok');
  });

  test.each([
    ['a negative total', ['-1', '1.5', "'x'"]],
    ['a rate that is not 1.5', ['5', '1.6', "'x'"]],
  ] as const)('%s is refused', async (_label, [total, rate, code]) => {
    expect(await check(total, rate, code)).toBe(CHECK_VIOLATION);
  });

  test.each([
    ['spaces around it', "'  x '", 'ok'],
    ['a tab before it', "E'\\tx'", CHECK_VIOLATION],
    ['a newline after it', "E'x\\n'", CHECK_VIOLATION],
  ])('trimmed() as btrim(): %s', async (_label, code, expected) => {
    expect(await check('5', '1.5', code)).toBe(expected);
  });
});
