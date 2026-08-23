import { describe, expect, test } from 'bun:test';
import { DevSourceUnavailableError } from '../errors';
import { staticDevSources } from './data';
import type { DriftFact, SqlResult, TableFact } from './facts';
import { assertReadOnly, dbPanel } from './panel-db';

/**
 * The refusal sentence, or `null` when the statement is runnable. `assertReadOnly` answers a
 * VERDICT — it carries the string that must actually be executed, because the guard it delegates
 * to reconciles the caller's bytes — and these cases only ever asked the yes/no half.
 */
const refusalOf = (sql: string): string | null => {
  const verdict = assertReadOnly(sql);
  return verdict.kind === 'refused' ? verdict.refused : null;
};

describe('assertReadOnly', () => {
  test('admits a plain SELECT', () => {
    expect(refusalOf('select * from members')).toBeNull();
  });

  test('refuses a real write statement', () => {
    expect(refusalOf("update members set name = 'x'")).not.toBeNull();
    expect(refusalOf('drop table members')).not.toBeNull();
  });

  test('does not false-positive on a write word inside a string literal', () => {
    // The bug: `\bcreate\b` matched the *word* anywhere, including inside a quoted value —
    // refusing a read-only SELECT that merely filters on one.
    expect(refusalOf("select * from events where kind = 'create'")).toBeNull();
    expect(refusalOf("select * from events where kind = 'delete'")).toBeNull();
    expect(refusalOf("select * from events where kind = 'update'")).toBeNull();
  });

  test('a write word split across an escaped quote inside a literal is still just a literal', () => {
    expect(refusalOf("select * from t where note = 'it''s a create event'")).toBeNull();
  });

  test('ignores a line comment naming a write word', () => {
    expect(refusalOf('select * from members -- drop everything\n')).toBeNull();
  });

  test('ignores a block comment naming a write word', () => {
    expect(refusalOf('select * from members /* insert here later */')).toBeNull();
    expect(refusalOf('/* multi\nline\ndelete */ select 1')).toBeNull();
  });

  test('a real write statement hidden after a comment is still refused', () => {
    expect(refusalOf('-- looks safe\ndelete from members')).not.toBeNull();
    expect(refusalOf('/* comment */ drop table members')).not.toBeNull();
  });

  test('refuses a write statement wrapped in a read-looking CTE', () => {
    expect(
      refusalOf('with x as (delete from members returning id) select * from x'),
    ).not.toBeNull();
  });

  test('blank / comment-only input is not a refusal — the panel treats it as "nothing typed yet"', () => {
    expect(refusalOf('')).toBeNull();
    expect(refusalOf('   ')).toBeNull();
    expect(refusalOf('-- just a comment')).toBeNull();
  });

  test('refuses a statement that is not a recognized read form', () => {
    expect(refusalOf('call some_procedure()')).not.toBeNull();
  });

  test('a comment marker smuggled through a quoted identifier does not hide the write', () => {
    // The bypass this guard existed to stop and did not: blanking `--` before quoted spans left
    // the scan looking at `select 1 as "` and calling it a read, while Postgres ran both
    // statements. Same shape for a dollar-quoted body, which is a string Postgres does not
    // terminate on `'`.
    expect(refusalOf('select 1 as "--"; delete from members')).not.toBeNull();
    expect(refusalOf('select $$--$$; drop table members')).not.toBeNull();
    expect(refusalOf('select $tag$--$tag$; truncate members')).not.toBeNull();
  });

  test('a quoted identifier that only looks like a write is still a read', () => {
    expect(refusalOf('select "delete" from members')).toBeNull();
    expect(refusalOf('select id as "update count" from members')).toBeNull();
    expect(refusalOf('select $$ delete from members $$ as note')).toBeNull();
  });

  // The gap that made this a second, weaker guard: the keyword scan had no notion of a CALL, so
  // every statement below is a syntactically perfect SELECT and every one of them does something
  // a read may not do. `@ultimat3/mcp`'s guard already refused all of them; this panel now asks it.
  test('refuses a read that calls out of the database, or holds a lock, or burns the clock', () => {
    expect(refusalOf("select pg_read_file('/etc/passwd')")).not.toBeNull();
    expect(refusalOf('select pg_sleep(60)')).not.toBeNull();
    expect(refusalOf('select pg_advisory_lock(1)')).not.toBeNull();
    expect(refusalOf("select set_config('work_mem', '1GB', false)")).not.toBeNull();
    expect(refusalOf('select * from members for update')).not.toBeNull();
  });

  test('refuses a batch, even when every statement in it reads', () => {
    // Batching is how a write rides in behind a read; the old scan tested the whole blob at once.
    expect(refusalOf('select 1; select 2')).not.toBeNull();
  });

  test('a column whose name merely starts with a forbidden family is still readable', () => {
    // The rule is a prefix on a CALL, never on a bare word — otherwise this is a false refusal.
    expect(refusalOf('select pg_sleep_for_seconds from timings')).toBeNull();
  });

  // An unterminated delimiter blanks the remainder, so the `;` and the write keyword vanish
  // before the statement count, the leader check and the write-keyword scan ever look. ALL FIVE
  // forms failed open at once; a local test for a surviving `'`/`"` covered three of them and
  // called a dollar-quoted body "a quote". Pinned here as one table because it is one mechanism.
  test.each([
    ['single quote', "select '; delete from members"],
    ['E-string', "select E'x ; delete from members"],
    ['double quote', 'select "; drop table members'],
    ['dollar quote', 'select $tag$ ; delete from members'],
    ['block comment', 'select 1 /* ; delete from members'],
  ])('an unterminated %s cannot hide the statement behind it', (_form, sql) => {
    expect(refusalOf(sql)).not.toBeNull();
  });

  test('a refusal never sends the developer to a flag that cannot fix it', () => {
    // `x db psql --write` grants writes; it does not close a delimiter. Asserting the shape of
    // the sentence, never another package's prose — only that this panel stopped claiming the
    // write flag IS the fix.
    const refusal = refusalOf("select '; delete from members") ?? '';
    expect(refusal).toContain('Fix the statement, or');
    expect(refusal).toContain('x db psql --write');
  });
});

describe('dbPanel.data', () => {
  const TABLES: readonly TableFact[] = [
    { name: 'members', columns: [{ name: 'id', type: 'uuid', nullable: false }] },
  ];
  const DRIFT: readonly DriftFact[] = [
    { table: 'members', column: 'nickname', issue: 'column missing in the database' },
  ];
  const RESULT: SqlResult = { columns: ['id'], rows: [['m_1']], elapsedMs: 3 };

  /** Records every statement handed to the SQL tool, so "was it run at all" is assertable. */
  function sources(over: Partial<Parameters<typeof staticDevSources>[0]> = {}): {
    readonly sources: ReturnType<typeof staticDevSources>;
    readonly ran: string[];
  } {
    const ran: string[] = [];
    return {
      ran,
      sources: staticDevSources({
        tables: () => Promise.resolve(TABLES),
        drift: () => Promise.resolve(DRIFT),
        runSql: (sql: string) => {
          ran.push(sql);
          return Promise.resolve(RESULT);
        },
        ...over,
      }),
    };
  }

  test('the schema and the drift render with no statement typed', async () => {
    const fixture = sources();
    const data = await dbPanel.data(fixture.sources, new URLSearchParams());

    expect(data.tables).toEqual(TABLES);
    expect(data.drift).toEqual(DRIFT);
    expect(data.sql).toBeNull();
    expect(data.result).toBeNull();
    expect(data.refused).toBeNull();
    expect(data.readOnly).toBe(true);
    // Nothing was typed, so nothing was executed — an empty box is not a query.
    expect(fixture.ran).toEqual([]);
  });

  // `null`, never `[]`. An empty drift list is the answer a checker that RAN gives, and printing
  // it for a process that holds no connection tells an operator the schema matches when nobody
  // looked. `defaultDevSources().drift` refuses for exactly this reason.
  test('an unwired drift check is null — "nobody looked", not "nothing wrong"', async () => {
    const fixture = sources({
      drift: () => Promise.reject(new DevSourceUnavailableError({ source: 'drift', panel: 'db' })),
    });
    const data = await dbPanel.data(fixture.sources, new URLSearchParams());

    expect(data.drift).toBeNull();
    // The rest of the panel still renders: a missing drift check must not cost the table list.
    expect(data.tables).toEqual(TABLES);
  });

  test('a drift check that RAN and failed is a diagnostic, not a blank cell', async () => {
    const fixture = sources({
      drift: () => Promise.reject(new Error('connection reset while reading pg_catalog')),
    });
    // Anything that is not "unwired" reaches `panelPayload`, which renders its code and its fix.
    await expect(dbPanel.data(fixture.sources, new URLSearchParams())).rejects.toThrow(
      /connection reset/,
    );
  });

  test('whitespace short-circuits before the SQL tool is reached at all', async () => {
    const fixture = sources();
    const data = await dbPanel.data(fixture.sources, new URLSearchParams({ sql: '   ' }));
    expect(data.sql).toBeNull();
    expect(data.refused).toBeNull();
    expect(fixture.ran).toEqual([]);
  });

  test('a half-typed comment is not a REFUSAL — the box must not flash an error mid-keystroke', async () => {
    const fixture = sources();
    const data = await dbPanel.data(
      fixture.sources,
      new URLSearchParams({ sql: '-- still typing' }),
    );
    // `sanitize` blanks the comment, so the guard sees an empty statement and says nothing. It
    // does NOT short-circuit — only `trim() === ''` does — so the tool is still asked, which is
    // a no-op against a database and the panel's own definition of "read-only".
    expect(data.refused).toBeNull();
    expect(fixture.ran).toEqual(['-- still typing']);
  });

  test('a read statement is executed and its grid comes back', async () => {
    const fixture = sources();
    const data = await dbPanel.data(
      fixture.sources,
      new URLSearchParams({ sql: 'select id from members' }),
    );

    expect(data.sql).toBe('select id from members');
    expect(data.result).toEqual(RESULT);
    expect(data.refused).toBeNull();
    expect(fixture.ran).toEqual(['select id from members']);
  });

  test('a write statement is refused BEFORE the tool is called, with a way out', async () => {
    const fixture = sources();
    const data = await dbPanel.data(
      fixture.sources,
      new URLSearchParams({ sql: 'delete from members' }),
    );

    expect(data.result).toBeNull();
    expect(fixture.ran).toEqual([]);
    expect(data.refused).toContain('refused:');
    // Phrased for both classes that arrive through one code: a write, and a delimiter that never
    // closes. `--write` grants writes; it does not close a quote.
    expect(data.refused).toContain('Fix the statement');
    expect(data.refused).toContain('x db psql --write');
    // The statement the operator typed is still on screen for them to edit.
    expect(data.sql).toBe('delete from members');
  });

  /**
   * `assertReadOnlyQuery` states its contract in its own doc comment: "the string returned is the
   * caller's own `sql`, verbatim apart from surrounding whitespace and one trailing `;`, BECAUSE
   * the caller executes this value". The panel discarded that return and executed the textarea's
   * bytes instead — benign only for as long as `verbatim()` normalises nothing more than it does
   * today, which is a promise no other file is keeping. `dev-server.ts` in `@ultimat3/mcp` honours
   * the same contract, so the two callers of one guard must not disagree about which string runs.
   */
  test("what runs is the string the GUARD returned, never the textarea's own bytes", async () => {
    const fixture = sources();
    const data = await dbPanel.data(
      fixture.sources,
      new URLSearchParams({ sql: '  select id from members;  ' }),
    );

    expect(fixture.ran).toEqual(['select id from members']);
    expect(data.result).toEqual(RESULT);
    // What the operator typed is still what the textarea shows — the guard decides what RUNS.
    expect(data.sql).toBe('  select id from members;  ');
  });

  test('an unterminated delimiter is refused by the shared guard, not by a local scan', async () => {
    const fixture = sources();
    const data = await dbPanel.data(
      fixture.sources,
      new URLSearchParams({ sql: "select * from members where name = 'oops" }),
    );
    expect(data.refused).not.toBeNull();
    expect(fixture.ran).toEqual([]);
  });
});
