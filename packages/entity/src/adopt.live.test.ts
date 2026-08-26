// Adopting a table this framework did not create: the DDL is written by hand here, exactly as a
// legacy schema would have it — a table whose name is not the entity's, columns whose names are
// not `snake(property)`, and an amount column pair that predates the scale column entirely — and
// the entity is declared OVER it. Nothing generates a migration; that is the whole point.
//
// Skips unless `TEST_DATABASE_URL` is set, as the live suite does.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createPostgresClient, type PostgresClient, raw, setDbClient } from '@ultimat3/db';
import type { PlainDate } from '@ultimat3/time';
import { plainDate } from '@ultimat3/time';
import { money, text, timestamp, uuid } from './columns';
import { date } from './columns-data';
import { database } from './database';
import { entity } from './entity';
import { postgresDriver } from './pg-driver';
import { clearRegistry } from './registry';

const adminUrl = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof adminUrl === 'string' && adminUrl.length > 0;

/** The schema as it already exists. Not one line of this came out of `x db gen`. */
const LEGACY = `create table legacy_accounts (
  account_id   uuid primary key,
  gh_login     text not null,
  amount_cents bigint not null,
  currency     char(3) not null,
  opened_on    date not null,
  created_at   timestamptz not null default now()
)`;

const DROP = 'drop table if exists legacy_accounts cascade';

const accounts = entity('account', {
  // The entity is `account`; the table is `legacy_accounts`. The framework's key stays the name —
  // the cache tag is `entity:account` whatever the table is called.
  table: 'legacy_accounts',
  columns: {
    id: uuid().primaryKey().column('account_id'),
    githubLogin: text({ max: 40 }).column('gh_login'),
    // Two columns, not three: this table predates the scale column, and `scale: null` says so.
    balance: money({ columns: { minor: 'amount_cents', currency: 'currency', scale: null } }),
    openedOn: date().column('opened_on'),
    createdAt: timestamp().defaultNow().column('created_at'),
  },
});

describe.skipIf(!hasPostgres)('live · postgres · adopting an existing table', () => {
  let client: PostgresClient;

  beforeAll(async () => {
    client = createPostgresClient({ url: adminUrl ?? '' });
    setDbClient(client);
    await client.execute(raw(DROP));
    await client.execute(raw(LEGACY));
  });

  afterAll(async () => {
    await client.execute(raw(DROP));
    await client.close();
    setDbClient(undefined);
  });

  const db = () => database({ accounts }, { driver: postgresDriver() });

  test('a write lands in the physical columns the table actually has', async () => {
    const written = await db().accounts.insert({
      githubLogin: 'ada',
      balance: { minor: 125_000, currency: 'EUR' },
      openedOn: '2026-03-14' as PlainDate,
    });
    // Read back with SQL that names the LEGACY columns and knows nothing about the entity.
    const rows = await client.query<{
      gh_login: string;
      amount_cents: string;
      currency: string;
      opened_on: Date;
    }>(
      raw(
        `select gh_login, amount_cents, currency, opened_on from legacy_accounts where account_id = '${written.id}'`,
      ),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.gh_login).toBe('ada');
    expect(rows[0]?.amount_cents).toBe('125000');
    expect(rows[0]?.currency.trim()).toBe('EUR');
    expect(rows[0]?.opened_on.toISOString()).toBe('2026-03-14T00:00:00.000Z');
  });

  test('a read of the same table comes back as the entity row, property names and all', async () => {
    const found = await db().accounts.where({ githubLogin: 'ada' }).one();
    expect(found).not.toBeNull();
    expect(found?.githubLogin).toBe('ada');
    // The amount folds back out of two columns, with no scale key — that IS the absent column.
    expect(found?.balance).toEqual({ minor: 125_000, currency: 'EUR' });
    expect(found?.openedOn).toBe(plainDate('2026-03-14'));
    expect(found?.createdAt).toBeInstanceOf(Date);
  });

  test('a row this framework never wrote reads back the same way', async () => {
    // The adoption case proper: the row is inserted by something that is not Ultimate.
    await client.execute(
      raw(
        `insert into legacy_accounts (account_id, gh_login, amount_cents, currency, opened_on)
         values ('00000000-0000-7000-8000-00000000ff01', 'bruno', 4200, 'USD', '2019-11-02')`,
      ),
    );
    const found = await db().accounts.where({ githubLogin: 'bruno' }).one();
    expect(found?.balance).toEqual({ minor: 4200, currency: 'USD' });
    expect(found?.openedOn).toBe(plainDate('2019-11-02'));
  });

  test('an update and a filtered write address the physical columns too', async () => {
    const found = await db().accounts.where({ githubLogin: 'bruno' }).one();
    await db().accounts.update(found?.id ?? '', { githubLogin: 'bruno-2' });
    expect(await db().accounts.where({ githubLogin: 'bruno-2' }).count()).toBe(1);
    expect(
      await db().accounts.updateWhere(
        { githubLogin: 'bruno-2' },
        { balance: { minor: 1, currency: 'USD' } },
      ),
    ).toBe(1);
    const after = await db().accounts.where({ githubLogin: 'bruno-2' }).one();
    expect(after?.balance).toEqual({ minor: 1, currency: 'USD' });
  });

  test('ordering and cursors work over a renamed column, because the plan names properties', async () => {
    const page = await db().accounts.orderBy('githubLogin', 'asc').limit(1).page();
    expect(page.rows[0]?.githubLogin).toBe('ada');
    expect(page.nextCursor).not.toBeNull();
    const next = await db().accounts.orderBy('githubLogin', 'asc').after(page.nextCursor).all();
    expect(next[0]?.githubLogin).toBe('bruno-2');
  });
});

// Outside the block above and unconditional: bun runs no hook inside a skipped `describe`, and the
// registry is process-wide. `live-registry-cleanup.test.ts` is the rule that keeps it here.
afterAll(() => {
  clearRegistry();
});
