// `canonicalUuid` against the server's own parser: every spelling is asked of Postgres (PGlite),
// and the two must agree on which are a uuid and on the value each one names.

import { afterAll, beforeAll, expect, test } from 'bun:test';
import { type PgliteClient, pgliteClient, sql } from '@ultimat3/db';
import { canonicalUuid } from './uuid-text';

const ID = '0a1b2c3d-4e5f-7a6b-8c9d-0e1f2a3b4c5d';
const BARE = ID.replaceAll('-', '');

const SPELLINGS: readonly string[] = [
  ID,
  ID.toUpperCase(),
  BARE,
  `{${ID}}`,
  `{${BARE}}`,
  (BARE.match(/.{4}/g) ?? []).join('-'),
  `${BARE.slice(0, 8)}-${BARE.slice(8, 16)}-${BARE.slice(16)}`,
  ` ${ID}`,
  `${ID} `,
  `${ID}\n`,
  `{${ID}`,
  `${ID}}`,
  `{{${ID}}}`,
  ID.slice(1),
  `${ID}0`,
  `${BARE.slice(0, 2)}-${BARE.slice(2)}`,
  `${BARE}-`,
  `-${BARE}`,
  ID.replace('-', '--'),
  ID.replace('a', 'g'),
  '',
  '{}',
  'nope',
];

let pglite: PgliteClient;

beforeAll(() => {
  pglite = pgliteClient();
});

afterAll(async () => {
  await pglite.close();
});

test.each(SPELLINGS)('%p is read as Postgres reads it', async (spelling) => {
  const server = await pglite
    .query<{ readonly id: string }>(sql`select ${spelling}::uuid::text as id`)
    .then(
      (rows) => rows[0]?.id,
      () => undefined,
    );
  expect(canonicalUuid(spelling)).toBe(server);
});

test('a value that is not text is no uuid', () => {
  expect([5, null, undefined, {}, [ID]].map(canonicalUuid)).toEqual(Array(5).fill(undefined));
});
