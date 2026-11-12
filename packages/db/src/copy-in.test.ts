// What `copy-in.ts` sends, without a server: the text-format line every bound value becomes, the
// refusals that keep a COPY from carrying a parameter or an unsendable cell, and the stream's
// open-write-close order against a writable double. `copy-in.live.test.ts` proves the server agrees.

import { afterEach, describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import type { DbClient } from './client';
import { canCopyIn, copyLine, copyOn } from './copy-in';
import { reservableOver } from './fake-reservable-fixture';
import { identifier, raw, sql } from './sql';
import { withTransaction } from './transaction';
import { setTransactionSettings } from './transaction-settings';

const target = sql`copy ${identifier('t')} (${identifier('a')}) from stdin`;

/** A `Bun.SQL` query double: `writable()` must come before anything awaits it, as on the driver. */
const copyDouble = (count: number, failOnClose?: unknown) => {
  const written: string[] = [];
  const order: string[] = [];
  let started = false;
  let settle: (value: unknown) => void = () => undefined;
  let refuse: (reason: unknown) => void = () => undefined;
  const answer = new Promise((resolve, reject) => {
    settle = resolve;
    refuse = reject;
  });
  const query = Object.assign(answer, {
    writable() {
      if (started) expect.unreachable('writable() after the query started');
      started = true;
      return new WritableStream<string>({
        write(chunk) {
          written.push(chunk);
        },
        close() {
          order.push('close');
          if (failOnClose !== undefined) {
            refuse(failOnClose);
            throw failOnClose;
          }
          settle(Object.assign([], { count, command: 'COPY' }));
        },
        abort(reason) {
          order.push('abort');
          refuse(reason);
        },
      });
    },
  });
  const texts: string[] = [];
  const driver = {
    unsafe(text: string) {
      texts.push(text);
      return query;
    },
  };
  return { driver, written, order, texts };
};

describe('copyLine', () => {
  test('a null is \\N, never the four letters of the word', () => {
    expect(copyLine([null, undefined, 'NULL'])).toBe('\\N\t\\N\tNULL\n');
  });

  test('a tab, a newline, a carriage return and a backslash cannot end a cell or a row', () => {
    expect(copyLine(['a\tb', 'c\nd', 'e\rf', 'g\\h'])).toBe('a\\tb\tc\\nd\te\\rf\tg\\\\h\n');
  });

  test('scalars spell what their input function reads', () => {
    expect(copyLine([1, 2.5, 10n, true, false])).toBe('1\t2.5\t10\tt\tf\n');
  });

  test('a Date is its ISO instant, an Invalid Date is refused', () => {
    expect(copyLine([new Date('2026-01-02T03:04:05.678Z')])).toBe('2026-01-02T03:04:05.678Z\n');
    expect(() => copyLine([new Date('nope')])).toThrow(/Invalid Date/);
  });

  test('bytes are bytea hex with the backslash the text format eats doubled', () => {
    expect(copyLine([new Uint8Array([1, 255])])).toBe('\\\\x01ff\n');
  });

  test('a JS array is an array literal, escaped like any other text', () => {
    expect(copyLine([['x,y', 'z\\']])).toBe('{"x,y","z\\\\\\\\"}\n');
  });

  test('a plain object is refused X_SQL_UNSAFE — jsonb arrives as its JSON text', () => {
    try {
      copyLine([{ a: 1 }]);
      expect.unreachable('a plain object has no COPY text');
    } catch (error) {
      expect(isUltimateError(error) && error.code).toBe('X_SQL_UNSAFE');
    }
  });
});

describe('copyOn', () => {
  test('one statement, the rows as text-format lines, closed, the server count answered', async () => {
    const copy = copyDouble(2);
    const count = await copyOn(copy.driver, target, [
      [1, 'a'],
      [2, null],
    ]);
    expect(count).toBe(2);
    expect(copy.texts).toEqual(['copy "t" ("a") from stdin']);
    expect(copy.written.join('')).toBe('1\ta\n2\t\\N\n');
    expect(copy.order).toEqual(['close']);
  });

  test('a cell it cannot encode aborts the stream: nothing stored, the refusal is what throws', async () => {
    const copy = copyDouble(0);
    try {
      await copyOn(copy.driver, target, [[1], [{ a: 1 }]]);
      expect.unreachable('the second row holds a plain object');
    } catch (error) {
      expect(isUltimateError(error) && error.code).toBe('X_SQL_UNSAFE');
    }
    expect(copy.order).toEqual(['abort']);
  });

  test("the server's refusal is typed by its SQLSTATE", async () => {
    const duplicate = Object.assign(new Error('duplicate key'), { errno: '23505' });
    const copy = copyDouble(0, duplicate);
    try {
      await copyOn(copy.driver, target, [[1]]);
      expect.unreachable('the close was refused');
    } catch (error) {
      expect(isUltimateError(error) && error.code).toBe('X_DB_UNIQUE_VIOLATION');
    }
  });

  test('a target that binds a value, or is not a COPY FROM STDIN, is refused before a send', async () => {
    const copy = copyDouble(0);
    for (const bad of [sql`copy t (a) from stdin where a = ${1}`, sql`select 1`]) {
      try {
        await copyOn(copy.driver, bad, [[1]]);
        expect.unreachable('not a parameterless COPY FROM STDIN');
      } catch (error) {
        expect(isUltimateError(error) && error.code).toBe('X_SQL_UNSAFE');
      }
    }
    expect(copy.texts).toEqual([]);
  });

  test('only `copy <ident>[.<ident>] (<cols>) from stdin`: the injections are refused before a send', async () => {
    const copy = copyDouble(0);
    for (const text of [
      "copy (select 1) to program 'id' -- from stdin",
      "copy t from '/etc/passwd' /* from stdin */",
      'copy t from stdin; drop table t',
      'copy t (a) from stdin; drop table t',
      'copy "t" ("a") from stdin -- x',
      'copy t from stdin',
    ]) {
      try {
        await copyOn(copy.driver, raw(text), [[1]]);
        expect.unreachable(`not an anchored COPY FROM STDIN: ${text}`);
      } catch (error) {
        expect(isUltimateError(error) && error.code).toBe('X_SQL_UNSAFE');
      }
    }
    expect(copy.texts).toEqual([]);
  });

  test('a qualified, quoted target with a quoted column list is accepted', async () => {
    const copy = copyDouble(1);
    const qualified = raw('copy "app"."t ""x""" ("a", "b c") from stdin');
    expect(await copyOn(copy.driver, qualified, [[1, 2]])).toBe(1);
  });

  test("a throw from the caller's rows is a coded refusal, never X_DB_UNAVAILABLE; the stream aborts", async () => {
    const copy = copyDouble(0);
    const failure = new RangeError('the source failed');
    function* rows(): Generator<readonly unknown[]> {
      yield [1];
      throw failure;
    }
    try {
      await copyOn(copy.driver, target, rows());
      expect.unreachable('the iterator threw');
    } catch (error) {
      expect(isUltimateError(error) && error.code).toBe('X_INVARIANT');
      expect(String((error as Error).message)).toContain('the source failed');
      expect((error as { sourceError?: unknown }).sourceError).toBe(failure);
    }
    expect(copy.order).toEqual(['abort']);
  });

  test('a driver whose query has no writable() is refused, not hung', async () => {
    const driver = { unsafe: () => Promise.resolve([]) };
    try {
      await copyOn(driver, target, [[1]]);
      expect.unreachable('no copy stream');
    } catch (error) {
      expect(isUltimateError(error) && error.code).toBe('X_INVARIANT');
    }
  });
});

describe('canCopyIn', () => {
  afterEach(() => setTransactionSettings(undefined));
  const plain: DbClient = {
    query: async () => [],
    one: async () => null,
    execute: async () => 0,
  };
  const copying = { ...plain, copyIn: async () => 0 };

  test('only a client with copyIn', () => {
    expect(canCopyIn(plain)).toBe(false);
    expect(canCopyIn(copying)).toBe(true);
  });

  test('never while a row-security provider is installed, tenant or not: Postgres refuses COPY FROM under RLS (0A000)', () => {
    setTransactionSettings(() => ({ 'x.tenant': 'acme' }));
    expect(canCopyIn(copying)).toBe(false);
    setTransactionSettings(() => undefined);
    expect(canCopyIn(copying)).toBe(false);
    setTransactionSettings(undefined);
    expect(canCopyIn(copying)).toBe(true);
  });
});

describe('copyIn on a transaction handle', () => {
  test('a pin that copies makes a DbTx that copies, on the pin, inside the BEGIN', async () => {
    const sent: string[] = [];
    const inner: DbClient = {
      query: async () => [],
      one: async () => null,
      execute: async (fragment) => {
        sent.push(fragment.text);
        return 0;
      },
    };
    const { client } = reservableOver(inner);
    const pinned = client.reserve.bind(client);
    client.reserve = async () =>
      Object.assign(await pinned(), {
        copyIn: async (target: { readonly text: string }) => {
          sent.push(target.text);
          return 1;
        },
      });
    const copied = await withTransaction(
      async (tx) => (canCopyIn(tx) ? tx.copyIn(target, [[1]]) : -1),
      { client },
    );
    expect(copied).toBe(1);
    expect(sent).toEqual(['BEGIN', 'copy "t" ("a") from stdin', 'COMMIT']);
  });

  test('a pin that cannot copy leaves the DbTx without copyIn', async () => {
    const { client } = reservableOver({
      query: async () => [],
      one: async () => null,
      execute: async () => 0,
    });
    expect(await withTransaction(async (tx) => canCopyIn(tx), { client })).toBe(false);
  });
});
