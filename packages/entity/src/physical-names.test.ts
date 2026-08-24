// The physical layer, said out loud: a table whose name is not the entity's, a column whose name
// is not `snake(property)`, and money's three columns where the table already put them. Every
// projection has to read the same answer — the DDL, the binding, the decoder, the index names and
// the invariant SQL — because the second place that spells a name is the one that gets it wrong.

import { afterAll, describe, expect, test } from 'bun:test';
import { t } from '@ultimat3/schema';
import { plainDate } from '@ultimat3/time';
import { columnName, moneyColumns } from './column';
import { integer, money, text, timestamp, uuid } from './columns';
import { date, json } from './columns-data';
import { database, memoryDriver } from './database';
import { entity } from './entity';
import { invariant } from './invariants';
import { allColumns, bindValues, columnsOf, decodeRow, physicalName } from './pg-row';
import { selectStatement } from './pg-sql';
import { insertStatement } from './pg-write-sql';
import { readPlan } from './plan';
import { clearRegistry } from './registry';

afterAll(() => {
  clearRegistry();
});

const caught = (run: () => unknown): string | undefined => {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return undefined;
};

/** An entity over a table nobody here created: `account` on `legacy_accounts`. */
const accounts = entity('account', {
  table: 'legacy_accounts',
  columns: {
    id: uuid().primaryKey().column('account_id'),
    githubLogin: text({ max: 40 }).column('gh_login').unique(),
    balance: money({ columns: { minor: 'amount_cents', currency: 'currency', scale: null } }),
    openedOn: date().column('opened_on'),
    seats: integer().column('seat_count'),
    createdAt: timestamp().column('created_at').defaultNow(),
    settings: json(t.object({ beta: t.boolean })).column('settings_json'),
  },
  invariants: (c) => [invariant('account_seats_positive', c.seats.atLeast(1))],
  indexes: [{ on: ['githubLogin', 'seats'] }],
});

describe('unit · the table an entity is bound to', () => {
  test('the entity keeps its NAME and the statements take the table', () => {
    expect(accounts.$name).toBe('account');
    expect(accounts.$table).toBe('legacy_accounts');
    // The cache tag follows the name, never the table: renaming a table must not move a tag.
    expect(accounts.$cacheTag).toBe('entity:account');
    expect(accounts.$describe().name).toBe('account');
    expect(accounts.$describe().table).toBe('legacy_accounts');
  });

  test('every statement names the table, and every predicate the physical column', () => {
    const plan = readPlan(
      accounts,
      { where: [{ column: 'githubLogin', op: 'eq', value: 'ada' }] },
      'findMany',
    );
    // `ReadShape.includeDeleted` is required, not defaulted — the same "no ambient default" rule
    // a timezone gets: whether a statement hides soft-deleted rows is the caller's to state.
    const select = selectStatement(accounts, plan, { includeDeleted: false }, 10);
    expect(select.text).toContain('"legacy_accounts"');
    expect(select.text).toContain('"gh_login"');
    expect(select.text).not.toContain('github_login');
    const insert = insertStatement(accounts, [new Map([['gh_login', 'ada']])], {
      columns: ['gh_login'],
    });
    expect(insert.text).toContain('insert into "legacy_accounts" ("gh_login")');
  });

  test('an index and its name are the table’s, not the entity name’s', () => {
    const names = accounts.$indexes.map((index) => index.name);
    expect(names).toContain('legacy_accounts_gh_login_key');
    expect(names).toContain('legacy_accounts_gh_login_seat_count_idx');
    expect(names.some((name) => name.startsWith('account_'))).toBe(false);
  });

  test('an invariant compiles to SQL over the physical columns', () => {
    expect(accounts.$migration()).toContain('seat_count');
    expect(accounts.$migration()).not.toContain('"seats"');
  });

  test('a table name that could not be quoted safely is refused where it is written', () => {
    expect(
      caught(() =>
        entity('bad', {
          table: 'legacy"; drop table users; --',
          columns: { id: uuid().primaryKey() },
        }),
      ),
    ).toContain('physical column name');
    expect(caught(() => text().column(''))).toContain('physical column name');
    expect(caught(() => text().column('Mixed_Case'))).toContain('physical column name');
    expect(caught(() => text().column('a'.repeat(64)))).toContain('physical column name');
  });
});

describe('unit · the column a property is bound to', () => {
  test('one resolver answers for every projection', () => {
    expect(columnName('githubLogin', accounts.githubLogin.$meta)).toBe('gh_login');
    expect(physicalName(accounts, 'githubLogin')).toBe('gh_login');
    expect(columnsOf('githubLogin', accounts.githubLogin)).toEqual(['gh_login']);
    // A property with no override still snake-cases, which is what keeps this additive.
    expect(columnName('openedOn', accounts.openedOn.$meta)).toBe('opened_on');
    expect(allColumns(accounts)).toEqual([
      'account_id',
      'gh_login',
      'amount_cents',
      'currency',
      'opened_on',
      'seat_count',
      'created_at',
      'settings_json',
    ]);
  });

  test('the DDL projection describes the physical columns and the physical primary key', () => {
    const description = accounts.$describe();
    expect(description.primaryKey).toEqual(['account_id']);
    const columns = new Map(description.columns.map((one) => [one.column, one]));
    expect(columns.get('gh_login')?.property).toBe('githubLogin');
    expect(columns.get('seat_count')?.kind).toBe('integer');
    expect(columns.get('settings_json')?.kind).toBe('jsonb');
    expect(columns.has('github_login')).toBe(false);
  });

  test('a value binds to the physical column and decodes back to the property', () => {
    const bound = bindValues(accounts, {
      githubLogin: 'ada',
      seats: 3,
      openedOn: '2026-03-14' as never,
    });
    expect(bound.get('gh_login')).toBe('ada');
    expect(bound.get('seat_count')).toBe(3);
    expect(bound.get('opened_on')).toBe('2026-03-14');
    expect(bound.has('github_login')).toBe(false);

    const row = decodeRow(accounts, {
      account_id: '00000000-0000-7000-8000-0000000000d1',
      gh_login: 'ada',
      amount_cents: 1250,
      currency: 'EUR',
      opened_on: new Date('2026-03-14T00:00:00.000Z'),
      seat_count: 3,
      created_at: new Date('2026-01-01T00:00:00.000Z'),
      settings_json: { beta: true },
    });
    expect(row.githubLogin).toBe('ada');
    expect(row.seats).toBe(3);
    expect(row.openedOn).toBe(plainDate('2026-03-14'));
    expect(row.settings).toEqual({ beta: true });
  });
});

describe('unit · money over columns a table already had', () => {
  test('the three names are per-part, merged over the defaults', () => {
    expect(moneyColumns('balance', accounts.balance.$meta)).toEqual({
      minor: 'amount_cents',
      currency: 'currency',
      scale: null,
    });
    // Nothing named: the defaults, exactly as every entity had them before this existed.
    expect(moneyColumns('price', money().$meta)).toEqual({
      minor: 'price_minor',
      currency: 'price_currency',
      scale: 'price_scale',
    });
    // One name given: the other two keep theirs.
    expect(moneyColumns('price', money({ columns: { minor: 'price_cents' } }).$meta)).toEqual({
      minor: 'price_cents',
      currency: 'price_currency',
      scale: 'price_scale',
    });
  });

  test('a table with no scale column projects two columns, and describes two', () => {
    expect(columnsOf('balance', accounts.balance)).toEqual(['amount_cents', 'currency']);
    const columns = accounts.$describe().columns.map((one) => one.column);
    expect(columns).toContain('amount_cents');
    expect(columns).not.toContain('amount_scale');
    expect(columns).not.toContain('balance_scale');
  });

  test('an amount binds to the two columns and folds back out of them', () => {
    const bound = bindValues(accounts, { balance: { minor: 1250, currency: 'EUR' } });
    expect(bound.get('amount_cents')).toBe(1250);
    expect(bound.get('currency')).toBe('EUR');
    expect(bound.has('balance_scale')).toBe(false);
    const row = decodeRow(accounts, { amount_cents: 1250, currency: 'EUR' });
    // No `scale` key: an absent scale column means the currency's own minor unit, as a NULL does.
    expect(row.balance).toEqual({ minor: 1250, currency: 'EUR' });
  });

  test('a money predicate names the physical part', () => {
    expect(physicalName(accounts, 'balance.minor')).toBe('amount_cents');
    expect(physicalName(accounts, 'balance.currency')).toBe('currency');
  });
});

describe('unit · the memory driver agrees with the physical layer', () => {
  test('a round trip through database() is the properties, whatever the columns are called', async () => {
    const db = database({ accounts }, { driver: memoryDriver() });
    const written = await db.accounts.insert({
      githubLogin: 'mara',
      balance: { minor: 900, currency: 'USD' },
      openedOn: '2026-05-01' as never,
      seats: 2,
      settings: { beta: false },
    });
    expect(written.githubLogin).toBe('mara');
    const found = await db.accounts.where({ githubLogin: 'mara' }).one();
    expect(found?.balance).toEqual({ minor: 900, currency: 'USD' });
    expect(found?.openedOn).toBe(plainDate('2026-05-01'));
  });
});
