// The three shipped statements that bind an array, executed against a real Postgres — which is the
// only thing that can say whether a parameter PARSES. Every existing test of these three asserts
// their SQL as TEXT against a recording executor, and all three were broken for as long as they
// have existed (#384).
//
// AGAINST POSTGRES, NEVER PGLITE, and that is the whole point of this file: `pglite.ts` is a
// separate driver that encodes an array parameter correctly, so a test that reached for the
// embedded default would pass with the bug restored. `x dev` runs that default, which is exactly
// why the framework's own dev loop never saw this and a container did.
//
// Skips unless `TEST_DATABASE_URL` is set. Locally:
//
//   docker run -d --rm --name x-array -e POSTGRES_PASSWORD=ultimate -e POSTGRES_USER=ultimate \
//     -e POSTGRES_DB=ultimate -p 55432:5432 postgres:17-alpine
//   TEST_DATABASE_URL=postgres://ultimate:ultimate@127.0.0.1:55432/ultimate \
//     bun test packages/db/src/array-parameter.live.test.ts

import { describe, expect, test } from 'bun:test';
import { encodeArrayParameters } from './array-parameter';

const url = Bun.env['TEST_DATABASE_URL'];
const describeLive = url === undefined ? describe.skip : describe;

/**
 * One connection per statement, opened and ended around it — the shape `dev-purge.live.test.ts`
 * uses, and here it is load-bearing rather than tidy: `max: 1` plus a statement Postgres refuses
 * leaves nothing for the next test to reuse, and a shared handle held at module scope keeps
 * `bun test` from exiting at all.
 */
const on = async <R>(text: string, values: readonly unknown[]): Promise<readonly R[]> => {
  const sql = new Bun.SQL(url ?? '', { max: 1 });
  try {
    return (await sql.unsafe(text, [...values])) as readonly R[];
  } finally {
    await sql.end();
  }
};

/** The same call `sendOn` makes: the encoder, then `unsafe`. */
const run = <R>(text: string, values: readonly unknown[]): Promise<readonly R[]> =>
  on<R>(text, encodeArrayParameters(values));

describeLive('live · postgres · an array bound as a statement parameter', () => {
  // The defect itself, as a property rather than as a story: the raw form is what Bun sends and it
  // must fail, the encoded form is what this module sends and it must not. Asserting only the
  // second would pass with the encoder deleted on any driver that happened to encode.
  test('the raw JS array is refused by Postgres, and the encoded one is not', async () => {
    // `on` and not `run`: the raw array is what Bun sends today, and it must still fail — asserting
    // only the encoded half would pass with the encoder deleted on any driver that happened to
    // encode, which is exactly how PGlite hid this for the whole life of the framework.
    await expect(on('select $1::text[] as a', [['x', 'y']])).rejects.toThrow(
      /malformed array literal/,
    );
    const rows = await run<{ a: readonly string[] }>('select $1::text[] as a', [['x', 'y']]);
    expect(rows[0]?.a).toEqual(['x', 'y']);
  });

  test('an empty array is an empty array, never a null and never one empty element', async () => {
    const rows = await run<{ n: number }>('select array_length($1::text[], 1) as n', [[]]);
    expect(rows[0]?.n).toBeNull();
  });

  // Round-tripped through Postgres rather than compared as text: the grammar rules the unit test
  // asserts are only worth anything if the parser agrees with them.
  test('every element the grammar quotes comes back byte-identical', async () => {
    const values = ['a,b', 'a{b', 'a"b', 'a\\b', ' a ', '', 'NULL', 'plain'];
    const rows = await run<{ a: readonly string[] }>('select $1::text[] as a', [values]);
    expect(rows[0]?.a).toEqual(values);
  });

  test('a null element is the array null, and the string NULL is not', async () => {
    const rows = await run<{ a: readonly (string | null)[] }>('select $1::text[] as a', [
      [null, 'NULL'],
    ]);
    expect(rows[0]?.a).toEqual([null, 'NULL']);
  });

  test('a uuid array is what any($1::uuid[]) matches on', async () => {
    const id = '019b76da-a800-7397-9d07-a63ca80b3c96';
    const rows = await run<{ hit: number }>('select 1 as hit where $1::uuid = any($2::uuid[])', [
      id,
      [id],
    ]);
    expect(rows).toHaveLength(1);
  });

  // The refusal `pgArrayLiteral` performs, checked against the server it claims to be speaking
  // for. A guard whose only proof is its own unit test is a rule somebody invented; these two
  // cases say the rectangular nest really parses and the ragged one really does not, so the
  // refusal is the server's shape and not this module's taste.
  test('a rectangular nest is a real 2-dimensional array', async () => {
    const rows = await run<{ a: readonly (readonly string[])[] }>('select $1::text[][] as a', [
      [
        ['a', 'b'],
        ['c', 'd'],
      ],
    ]);
    expect(rows[0]?.a).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });

  test('the ragged literal this module refuses to build is one Postgres refuses to read', async () => {
    // `on` and not `run`: the encoder never emits this string, so the only way to ask Postgres
    // about it is to hand it over already built.
    await expect(on('select $1::text[][] as a', ['{{a,b},{c}}'])).rejects.toThrow(
      /malformed array literal/,
    );
  });

  // A negative control on the same statement: an id that is NOT in the array must not match, or
  // the test above is satisfied by an encoder that turns every array into a wildcard.
  test('a uuid the array does not hold does not match', async () => {
    const rows = await run<{ hit: number }>('select 1 as hit where $1::uuid = any($2::uuid[])', [
      '019b76da-a800-7397-9d07-a63ca80b3c97',
      ['019b76da-a800-7397-9d07-a63ca80b3c96'],
    ]);
    expect(rows).toHaveLength(0);
  });
});
