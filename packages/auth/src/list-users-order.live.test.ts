// `listUsersByOrg` answers ONE order on both adapters, against a real server whose database
// collation is linguistic (`en_US`, the default most clusters are created with): byte order, which
// is code-point order. `localeCompare` on one side and the database collation on the other agreed
// on nothing past plain lower-case ASCII — `'B' < 'a'` by byte, `'a' < 'B'` under `en_US`.
//
// Skips unless `TEST_DATABASE_URL` is set. It writes only rows it created, in `x_users`.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { frozenClock } from '@ultimat3/core';
import { createPostgresClient, raw, sql } from '@ultimat3/db';
import type { AuthAdapter } from './adapter';
import { BuiltinAdapter } from './builtin-adapter';
import { MemoryAdapter } from './memory-adapter';
import { AUTH_TABLES } from './tables';

const url = Bun.env['TEST_DATABASE_URL'];
const describeLive = url === undefined ? describe.skip : describe;

const ORG = '00000000-0000-7000-8000-00000000a0d1';
const DOMAIN = 'list-order-live.test';
const clock = frozenClock(1_700_000_000_000);

/**
 * In byte (`C`) order, which is code-point order: upper case before lower, `_` between them, an
 * accented letter after every ASCII one, and U+FF21 before the astral U+1D51E — the one pair
 * UTF-16 code-unit order (a lead surrogate is 0xD835) puts the other way round.
 */
const EMAILS_IN_ORDER = [
  `Zed@${DOMAIN}`,
  `_ops@${DOMAIN}`,
  `adam@${DOMAIN}`,
  `bob@${DOMAIN}`,
  `Émile@${DOMAIN}`,
  `Ａlpha@${DOMAIN}`,
  `\u{1d51e}stral@${DOMAIN}`,
];

let client: ReturnType<typeof createPostgresClient>;

const wipe = async (): Promise<void> => {
  await client.execute(sql`delete from x_users where email like ${`%@${DOMAIN}`}`);
};

beforeAll(async () => {
  if (url === undefined) return;
  client = createPostgresClient({ url, applicationName: 'auth-list-order-live' });
  for (const entry of AUTH_TABLES) {
    for (const statement of entry.split(';')) {
      if (statement.trim() !== '') await client.execute(raw(statement));
    }
  }
  await wipe();
});

afterAll(async () => {
  if (url === undefined) return;
  await wipe();
  await client.close();
});

describeLive('listUsersByOrg · one order on both adapters', () => {
  test('memory and Postgres both answer byte order, whatever the database collation', async () => {
    const adapters: readonly (readonly [string, AuthAdapter])[] = [
      ['MemoryAdapter', new MemoryAdapter(clock)],
      ['BuiltinAdapter', new BuiltinAdapter(client, clock)],
    ];
    const answers: string[][] = [];
    for (const [name, adapter] of adapters) {
      // Created out of order, so neither side can answer insertion order and pass.
      for (const [index, email] of [...EMAILS_IN_ORDER].reverse().entries()) {
        await adapter.createUser({
          id: `00000000-0000-7000-8000-${String(index + 1).padStart(12, '0')}`,
          email,
          passwordHash: null,
          orgId: ORG,
          roles: [],
          createdAt: clock.now(),
        });
      }
      answers.push([name, ...(await adapter.listUsersByOrg(ORG)).map((user) => user.email)]);
    }
    expect(answers).toEqual([
      ['MemoryAdapter', ...EMAILS_IN_ORDER],
      ['BuiltinAdapter', ...EMAILS_IN_ORDER],
    ]);
  });
});
