// Single responsibility: the statement SEQUENCE layer 2 emits, asserted in isolation. Order is
// the whole guarantee — a timeout set after the statement, a role assumed before the timeout, a
// cursor declared outside the transaction or a rollback that does not run are each a hole no
// live-database test would name, because every one of them still returns the right rows.

import { describe, expect, test } from 'bun:test';
import { renderThrowable } from '@ultimat3/core';
import type { DbClient, ReservableClient } from './client';
import { dbUnavailable } from './errors';
import { createRecordingClient } from './fake';
import { reservableOver } from './fake-reservable';
import { READONLY_TIMEOUT_MS, readOnlyQuery } from './readonly-query';

describe('readOnlyQuery', () => {
  test('the default order is BEGIN READ ONLY, timeout, statement, ROLLBACK', async () => {
    const client = createRecordingClient();
    const result = await readOnlyQuery('select 1', { client });

    expect(client.texts).toEqual([
      'BEGIN READ ONLY',
      `SET LOCAL statement_timeout = ${READONLY_TIMEOUT_MS}`,
      'select 1',
      'ROLLBACK',
    ]);
    expect(result.guards).toEqual(['txn:read-only', `timeout:${READONLY_TIMEOUT_MS}ms`]);
  });

  test('a role is set after the timeout and before the statement', async () => {
    const client = createRecordingClient();
    const result = await readOnlyQuery('select 1', { client, role: 'ultimate_readonly' });

    expect(client.texts).toEqual([
      'BEGIN READ ONLY',
      `SET LOCAL statement_timeout = ${READONLY_TIMEOUT_MS}`,
      'SET LOCAL ROLE "ultimate_readonly"',
      'select 1',
      'ROLLBACK',
    ]);
    expect(result.guards).toEqual([
      'txn:read-only',
      `timeout:${READONLY_TIMEOUT_MS}ms`,
      'role:ultimate_readonly',
    ]);
  });

  test('timeoutMs: 0 disables the timeout statement and its guard', async () => {
    const client = createRecordingClient();
    const result = await readOnlyQuery('select 1', { client, timeoutMs: 0 });

    expect(client.texts).toEqual(['BEGIN READ ONLY', 'select 1', 'ROLLBACK']);
    expect(result.guards).toEqual(['txn:read-only']);
  });

  /**
   * Only 0 disables the timeout, and a number that is not one is now REFUSED rather than
   * normalised. It used to fall back to the default silently, which meant an agent read ran under
   * a ceiling nobody wrote and nothing said so — the intent (never silently skip the layer) is
   * kept, and the caller is told which option it was.
   */
  test.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5])(
    'refuses timeoutMs %p instead of taking the default in silence',
    async (timeoutMs) => {
      const client = createRecordingClient();
      const rendered = renderThrowable(
        await readOnlyQuery('select 1', { client, timeoutMs }).catch((error: unknown) => error),
      );

      expect(rendered).toContain('X_INVARIANT');
      expect(rendered).toContain('timeoutMs');
      // And nothing was opened to find that out: the bound is decided before `BEGIN READ ONLY`.
      expect(client.texts).toEqual([]);
    },
  );

  /**
   * The refusal has to survive a pool that cannot answer. `timeoutMs` was screened AFTER
   * `reserve()` and after `BEGIN READ ONLY`, so an unbounded option on an exhausted pool handed
   * the caller the pool's error — or the wait for a connection — in place of the `X_INVARIANT`
   * naming the option they actually got wrong. A value this build cannot honour is refused before
   * anything is opened, the same order `rollback({ steps })` takes against the advisory lock.
   */
  test('an option this build cannot honour is refused before a connection is reserved', async () => {
    const exhausted = dbUnavailable('every pooled connection is checked out');
    let reserves = 0;
    const client: ReservableClient = {
      query: async () => [],
      one: async () => null,
      execute: async () => 0,
      reserve: async () => {
        reserves += 1;
        throw exhausted;
      },
    };

    const rendered = renderThrowable(
      await readOnlyQuery('select 1', { client, timeoutMs: Number.NaN }).catch(
        (error: unknown) => error,
      ),
    );

    expect(rendered).toContain('X_INVARIANT');
    expect(rendered).toContain('timeoutMs');
    expect(reserves).toBe(0);
  });

  test('a rejecting statement still rolls back and rethrows the original error', async () => {
    const calls: string[] = [];
    const boom = dbUnavailable('statement failed: select 1');
    const failing: DbClient = {
      query: async () => {
        throw boom;
      },
      one: async () => null,
      execute: async (fragment) => {
        calls.push(fragment.text);
        return 0;
      },
    };

    await expect(readOnlyQuery('select 1', { client: failing })).rejects.toBe(boom);
    expect(calls).toEqual([
      'BEGIN READ ONLY',
      `SET LOCAL statement_timeout = ${READONLY_TIMEOUT_MS}`,
      'ROLLBACK',
    ]);
  });

  test('maxRows fetches through a cursor declared after the role, inside the transaction', async () => {
    const client = createRecordingClient();
    const result = await readOnlyQuery('select * from events', {
      client,
      role: 'ultimate_readonly',
      maxRows: 101,
    });

    expect(client.texts).toEqual([
      'BEGIN READ ONLY',
      `SET LOCAL statement_timeout = ${READONLY_TIMEOUT_MS}`,
      'SET LOCAL ROLE "ultimate_readonly"',
      'DECLARE ultimate_read_cursor NO SCROLL CURSOR FOR select * from events',
      'FETCH FORWARD 101 FROM ultimate_read_cursor',
      'ROLLBACK',
    ]);
    expect(result.guards).toContain('fetch:101 rows');
  });

  test('a trailing semicolon does not split the DECLARE into two statements', async () => {
    const client = createRecordingClient();
    await readOnlyQuery('select 1;  ', { client, maxRows: 5 });

    expect(client.texts).toContain('DECLARE ultimate_read_cursor NO SCROLL CURSOR FOR select 1');
  });

  // A `;` the splitter already cut away, followed by a COMMENT: `statementsOf` reads that as one
  // statement (a chunk of pure noise is not a statement), so the text passes the one-statement
  // gate — and the trailing regex strip could not see it, because the text does not END in `;`.
  // `DECLARE … CURSOR FOR select 1; -- note` is two commands, which Postgres answers with
  // "cannot insert multiple commands into a prepared statement": an uncoded driver error out of
  // a path whose whole job is to bound the read.
  test('a trailing comment after the separator is not spliced into the DECLARE', async () => {
    const client = createRecordingClient();
    await readOnlyQuery('select 1; -- note', { client, maxRows: 5 });

    expect(client.texts).toContain('DECLARE ultimate_read_cursor NO SCROLL CURSOR FOR select 1');
    // Nothing carries the tail — the splice takes the COMMAND the splitter cut, not the text.
    expect(client.texts.some((text) => text.includes('-- note'))).toBe(false);
  });

  test.each([
    ['table events', true],
    ['values (1),(2)', true],
    ['  -- lead\n with x as (select 1) select * from x', true],
    ['explain select 1', false],
    ['show statement_timeout', false],
  ])('cursorability of %p is %p', async (statement, expected) => {
    const client = createRecordingClient();
    const result = await readOnlyQuery(statement, { client, maxRows: 7 });

    expect(result.guards.includes('fetch:7 rows')).toBe(expected);
    expect(client.texts.includes(statement)).toBe(!expected);
  });

  test.each([0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'maxRows %p is not a fetch count, so the statement runs whole',
    async (maxRows) => {
      const client = createRecordingClient();
      const result = await readOnlyQuery('select 1', { client, maxRows });

      expect(client.texts).toContain('select 1');
      expect(result.guards.some((guard) => guard.startsWith('fetch:'))).toBe(false);
    },
  );

  test("the caller's SQL reaches the driver byte-for-byte", async () => {
    const client = createRecordingClient();
    const statement = "select 'delete from posts' as note";
    await readOnlyQuery(statement, { client });

    const executed = client.statements[2];
    expect(executed?.text).toBe(statement);
    expect(executed?.values).toEqual([]);
  });

  test('a reservable client is reserved and released exactly once', async () => {
    const recorder = createRecordingClient();
    const { client: reservable, pins } = reservableOver(recorder);

    await readOnlyQuery('select 1', { client: reservable });

    expect(pins).toEqual({ reserves: 1, releases: 1 });
    expect(recorder.texts).toEqual([
      'BEGIN READ ONLY',
      `SET LOCAL statement_timeout = ${READONLY_TIMEOUT_MS}`,
      'select 1',
      'ROLLBACK',
    ]);
  });

  test('a rejecting BEGIN READ ONLY gives the pin back instead of leaking it', async () => {
    const boom = dbUnavailable('statement failed: BEGIN READ ONLY');
    // Every statement fails, the rollback included — a connection that could not BEGIN is exactly
    // the one that cannot ROLLBACK either.
    const dead: DbClient = {
      query: async () => [],
      one: async () => null,
      execute: async () => {
        throw boom;
      },
    };
    const { client: reservable, pins } = reservableOver(dead);

    await expect(readOnlyQuery('select 1', { client: reservable })).rejects.toBe(boom);
    expect(pins).toEqual({ reserves: 1, releases: 1 });
  });
});

describe('one statement, or none at all', () => {
  test('an embedded ";" is refused before the transaction opens', async () => {
    // Only the FIRST command is bounded by the guards this function installs, so a second one
    // undid `SET LOCAL statement_timeout` while `guards` still reported `timeout:5000ms` — the
    // BEGIN READ ONLY backstop held, but the reported guard list was a lie.
    const client = createRecordingClient();
    let code = 'no-throw';
    try {
      await readOnlyQuery('select 1; set statement_timeout = 0', { client, maxRows: 10 });
    } catch (error) {
      code = (error as { code?: string }).code ?? 'no-code';
    }
    expect(code).toBe('X_SQL_UNSAFE');
    // Nothing was opened: no BEGIN, no DECLARE, no ROLLBACK to clean up.
    expect(client.texts).toEqual([]);
  });

  test('the refusal does not depend on maxRows — the direct path splices too', async () => {
    const client = createRecordingClient();
    await expect(readOnlyQuery('select 1; delete from posts', { client })).rejects.toThrow(
      /X_SQL_UNSAFE/,
    );
    expect(client.texts).toEqual([]);
  });

  test('a ";" inside a literal or a comment is data, not a second statement', async () => {
    const client = createRecordingClient();
    await expect(readOnlyQuery("select ';'", { client })).resolves.toBeDefined();
    await expect(readOnlyQuery('select 1 -- ; nope', { client })).resolves.toBeDefined();
    // A trailing ";" is still one statement and still stripped before the DECLARE.
    const trailing = createRecordingClient();
    await readOnlyQuery('select 1;', { client: trailing, maxRows: 5 });
    expect(trailing.texts).toContain('DECLARE ultimate_read_cursor NO SCROLL CURSOR FOR select 1');
  });
});
