// Single responsibility: the CHECK a `matches()` invariant generates means, on a real server,
// exactly what `pattern.test()` means in TypeScript — and nothing an author writes inside a pattern
// can leave the string literal it is spliced into.
//
// A string comparison cannot say either thing. `expr.test.ts` proves the emitted TEXT and
// `pattern-portability.test.ts` proves the classifier; only Postgres can say that `~ '^\d+$'` is
// the regex the author wrote, that `\b` really is a BACKSPACE there, and that a `'` inside a
// pattern is data. Skips unless `TEST_DATABASE_URL` is set, exactly like `pg-driver.live.test.ts`.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import {
  createPostgresClient,
  generateMigration,
  type PostgresClient,
  raw,
  sql,
  sqlState,
  statementsOf,
} from '@ultimat3/db';
import { text, uuid } from './columns';
import { entity } from './entity';
import { invariantColumns } from './expr';
import { invariant } from './invariants';
import { clearRegistry } from './registry';

const adminUrl = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof adminUrl === 'string' && adminUrl.length > 0;

/** `check_violation` — the only refusal that means the CHECK decided, and not the column type. */
const CHECK_VIOLATION = '23514';

/** `examples/dummy`'s own slug rule, character for character. */
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * A pattern carrying every character that has closed a literal in this repository: a quote, a
 * statement separator, a comment opener, and a payload that would be a real `drop table` if any one
 * of them escaped. Every character in it is an ordinary literal to both engines — which is the
 * point. The hazard is in the QUOTING, never in the regex.
 */
const INJECTION = /^a'; drop table pattern_probe_victim; --$/;

/** A backslash pattern: the case where `'…'` and `E'…'` compile to two different regexes. */
const ESCAPED = /^\d{4}-\d{2}$/;

const posts = entity('pattern_probe_posts', {
  columns: { id: uuid().primaryKey(), slug: text({ max: 80 }) },
  invariants: (c) => [invariant('slug_shape', c.slug.matches(SLUG_PATTERN))],
});

const hazards = entity('pattern_probe_hazards', {
  columns: { id: uuid().primaryKey(), tag: text({ max: 80 }) },
  invariants: (c) => [invariant('tag_shape', c.tag.matches(INJECTION))],
});

const escapes = entity('pattern_probe_escapes', {
  columns: { id: uuid().primaryKey(), code: text({ max: 20 }) },
  invariants: (c) => [invariant('code_shape', c.code.matches(ESCAPED))],
});

const TABLES = [
  'pattern_probe_posts',
  'pattern_probe_hazards',
  'pattern_probe_escapes',
  'pattern_probe_victim',
];
const DROP = `drop table if exists ${TABLES.map((name) => `"${name}"`).join(', ')} cascade`;

const probe = { value: text() };
const c = invariantColumns<typeof probe>('pattern_probe', Object.keys(probe));

/** The SQL a rule compiles to, with the property standing in for the physical column name. */
const emittedSql = (source: RegExp): string => {
  const rule = c.value.matches(source).toSql((path) => path.join('_'));
  return rule ?? expect.unreachable(`${source} reached no SQL`);
};

/** Whether TypeScript's own half of the invariant holds for `value`. */
const inTypeScript = (source: RegExp, value: string): boolean =>
  c.value.matches(source).holds({ value });

/**
 * ONE fixture for the whole file. A `beforeAll` inside each `describe` looked right and was not:
 * bun runs the blocks in order, so the first block's `afterAll` had already dropped every table
 * before the second block's `beforeAll` ran, and two suites reported `42P01` for a table this file
 * had created.
 */
let client: PostgresClient;

beforeAll(async () => {
  if (!hasPostgres) return;
  client = createPostgresClient({ url: adminUrl ?? '' });
  await client.execute(raw(DROP));
  // The table an escaped literal would have dropped. Created BEFORE the migration, so its survival
  // is a fact about the migration and not about the order of this file.
  await client.execute(raw('create table "pattern_probe_victim" (id int)'));
  const migration = generateMigration({
    entities: [posts.$describe(), hazards.$describe(), escapes.$describe()],
    name: 'invariant pattern probe',
    now: new Date('2026-08-25T00:00:00.000Z'),
  });
  for (const statement of statementsOf(migration.up)) await client.execute(raw(statement));
});

afterAll(async () => {
  if (!hasPostgres) return;
  await client.execute(raw(DROP));
  await client.close();
  clearRegistry();
});

/** `undefined` when the server stored the row, otherwise the SQLSTATE that stopped it. */
const store = (table: string, column: string, value: string): Promise<string | undefined> =>
  client
    .execute(
      sql`insert into ${raw(`"${table}"`)} (id, ${raw(`"${column}"`)}) values (gen_random_uuid(), ${value})`,
    )
    .then(
      () => undefined,
      (error: unknown) => sqlState(error) ?? 'no-sqlstate',
    );

/** A predicate — the framework's own emitted text, or a bare source — against one bound value. */
const onServer = async (expression: string, value: string): Promise<boolean | string> => {
  try {
    const rows = await client.query<{ m: boolean | null }>(
      sql`select (${raw(expression)}) as m from (select ${value}::text as value) probe`,
    );
    return rows[0]?.m === true;
  } catch (error: unknown) {
    return sqlState(error) ?? 'error';
  }
};

/** Bound, never spliced: an unportable source cannot be emitted by `matches()` at all. */
const rawMatch = async (source: string, value: string): Promise<boolean | string> => {
  try {
    const rows = await client.query<{ m: boolean | null }>(
      sql`select (${value}::text ~ ${source}::text) as m`,
    );
    return rows[0]?.m === true;
  } catch (error: unknown) {
    return sqlState(error) ?? 'error';
  }
};

describe.skipIf(!hasPostgres)('live · postgres · a matches() invariant becomes a CHECK', () => {
  /**
   * The load-bearing one. Each row is judged twice — once by the CHECK the migration created and
   * once by `pattern.test` — and the two verdicts are asserted TOGETHER, so a CHECK that refuses
   * everything reads as a failure rather than as agreement on the rejected half.
   */
  test('the CHECK stores exactly the slugs TypeScript accepts, and refuses the rest with 23514', async () => {
    const corpus = [
      'hello-world',
      'a',
      'a1-b2-c3',
      '2026-in-review',
      'Hello-World',
      'hello world',
      '-leading',
      'trailing-',
      'double--hyphen',
      'has_underscore',
      '',
      "o'brien",
      'ünicode',
      'with\nnewline',
    ];
    for (const value of corpus) {
      const state = await store('pattern_probe_posts', 'slug', value);
      const accepted = inTypeScript(SLUG_PATTERN, value);
      expect([value, state === undefined, state]).toEqual([
        value,
        accepted,
        accepted ? undefined : CHECK_VIOLATION,
      ]);
    }
  });

  test('a row TypeScript refuses never reaches the server, and carries the coded refusal', () => {
    expect(() => posts.$assert({ id: 'x', slug: 'hello-world' })).not.toThrow();
    try {
      posts.$assert({ id: 'x', slug: 'Hello World' });
      expect.unreachable('the invariant approved a slug its own CHECK refuses');
    } catch (error) {
      expect(isUltimateError(error) ? error.code : 'not-coded').toBe('X_INVARIANT_VIOLATED');
    }
  });

  test('a newline is where an unanchored reading and this one part company', async () => {
    // ARE and JavaScript both anchor `$` at the end of the STRING here, which is the only reason
    // `'good\nBAD'` is refused by both. `.` would have made them disagree, which is why it is not
    // in the subset at all.
    expect(await onServer(emittedSql(SLUG_PATTERN), 'good\nbad')).toBe(false);
    expect(inTypeScript(SLUG_PATTERN, 'good\nbad')).toBe(false);
  });
});

const exists = async (table: string): Promise<boolean> => {
  const rows = await client.query<{ present: boolean }>(
    sql`select to_regclass(${table}) is not null as present`,
  );
  return rows[0]?.present === true;
};

describe.skipIf(!hasPostgres)('live · postgres · a pattern cannot escape its literal', () => {
  test('the drop table inside a pattern is data — the victim table is still there', async () => {
    // The migration in the block above already ran with this pattern in it. If the quote had
    // closed, `drop table pattern_probe_victim` would have been a statement rather than characters
    // a regex is built from.
    expect(await exists('pattern_probe_victim')).toBe(true);
  });

  test("a pattern's quote, semicolon and -- survive as the characters the author wrote", async () => {
    const target = "a'; drop table pattern_probe_victim; --";
    const state = await client
      .execute(
        sql`insert into "pattern_probe_hazards" (id, tag) values (gen_random_uuid(), ${target})`,
      )
      .then(
        () => undefined,
        (error: unknown) => sqlState(error) ?? 'no-sqlstate',
      );
    // The one string the pattern spells is stored, so the CHECK is holding that exact regex and
    // not a truncated one — a literal that ended early would have refused it.
    expect(state).toBeUndefined();
    expect(inTypeScript(INJECTION, target)).toBe(true);
    // And nothing else is.
    const other = await client
      .execute(sql`insert into "pattern_probe_hazards" (id, tag) values (gen_random_uuid(), 'a')`)
      .then(
        () => undefined,
        (error: unknown) => sqlState(error) ?? 'no-sqlstate',
      );
    expect(other).toBe(CHECK_VIOLATION);
    expect(inTypeScript(INJECTION, 'a')).toBe(false);
    expect(await exists('pattern_probe_victim')).toBe(true);
  });
});

describe.skipIf(!hasPostgres)("live · postgres · E'' fixes the dialect in the text", () => {
  /**
   * Its own client, and `max: 1` is load-bearing: `standard_conforming_strings` is a SESSION
   * setting and the probe has to run on the connection the `set` landed on. On a pooled client the
   * second statement can take a different connection and the measurement silently reads the
   * default — which is the value it exists to move away from.
   */
  let pinned: PostgresClient;

  beforeAll(async () => {
    pinned = createPostgresClient({ url: adminUrl ?? '', profile: { max: 1 } });
    await pinned.execute(raw('set standard_conforming_strings = off'));
  });

  afterAll(async () => {
    await pinned.execute(raw('set standard_conforming_strings = on'));
    await pinned.close();
  });

  const answer = async (expression: string, value: string): Promise<boolean | string> => {
    try {
      const rows = await pinned.query<{ m: boolean | null }>(
        sql`select (${raw(expression)}) as m from (select ${value}::text as value) probe`,
      );
      return rows[0]?.m === true;
    } catch (error: unknown) {
      return sqlState(error) ?? 'error';
    }
  };

  test('the emitted literal is an escape string, and only because the pattern has a backslash', () => {
    expect(emittedSql(ESCAPED)).toContain("E'");
    expect(emittedSql(SLUG_PATTERN)).not.toContain("E'");
  });

  test('the plain form compiles a DIFFERENT regex here, and the emitted form does not', async () => {
    const plain = `value ~ '${ESCAPED.source}'`;
    // `\d` becomes the letter `d` under this setting: the server accepts `dddd-dd` and refuses
    // `2026-08`, the exact opposite of the rule the author wrote.
    expect(await answer(plain, 'dddd-dd')).toBe(true);
    expect(await answer(plain, '2026-08')).toBe(false);
    // What `matches()` emits answers the same under both settings, which is the whole reason for
    // the prefix.
    expect(await answer(emittedSql(ESCAPED), 'dddd-dd')).toBe(false);
    expect(await answer(emittedSql(ESCAPED), '2026-08')).toBe(true);
    expect(inTypeScript(ESCAPED, 'dddd-dd')).toBe(false);
    expect(inTypeScript(ESCAPED, '2026-08')).toBe(true);
  });
});

describe.skipIf(!hasPostgres)('live · postgres · the subset and what it leaves out', () => {
  /**
   * Every construct the scanner refuses, with a value the two engines answer DIFFERENTLY for. This
   * is what stops the refusal list from being someone's opinion: an entry that stops disagreeing —
   * a future Postgres growing JavaScript's `\b`, say — fails here, and the row is then deletable
   * with evidence rather than kept out of caution.
   */
  test('every refused construct really does answer differently on this server', async () => {
    const divergent: readonly (readonly [string, string])[] = [
      ['a.b', 'a\nb'],
      ['a.b', 'a\rb'],
      ['\\bfoo', 'foo'],
      ['^\\w$', 'é'],
      ['^\\s$', ' '],
      ['^[[:alpha:]]$', 'a'],
      ['^[]a]$', ']'],
      ['^\\x414$', 'Д'],
      ['^\\Aa$', 'a'],
      ['^a\\Z$', 'a'],
      ['^\\a$', ''],
      ['^\\e$', ''],
      ['^\\B$', '\\'],
      ['^\\q$', 'q'],
      ['^(?<y>a)$', 'a'],
      ['^{2}$', '{2}'],
    ];
    for (const [source, value] of divergent) {
      const server = await rawMatch(source, value);
      let js: boolean | string;
      try {
        js = new RegExp(source).test(value);
      } catch {
        js = 'error';
      }
      expect([source, value, server === js]).toEqual([source, value, false]);
    }
  });

  /**
   * And the other half: everything the subset KEEPS agrees. A rule that only ever refuses is not a
   * feature, and this is the list an author is left with.
   */
  test('every construct the subset keeps agrees on this server', async () => {
    const agreeing: readonly (readonly [RegExp, string])[] = [
      [SLUG_PATTERN, 'hello-world'],
      [SLUG_PATTERN, 'Hello-World'],
      [/^\d{4}-\d{2}-\d{2}$/, '2026-08-25'],
      [/^\d{4}-\d{2}-\d{2}$/, '26-8-5'],
      [/^[A-Z]{3}$/, 'USD'],
      [/^[A-Z]{3}$/, 'usd'],
      [/^(?=[^\n\r]*[0-9])[a-z0-9]+$/, 'ab1'],
      [/^(?=[^\n\r]*[0-9])[a-z0-9]+$/, 'abc'],
      [/^(?!x)[a-z]+$/, 'abc'],
      [/^(?!x)[a-z]+$/, 'xbc'],
      [/^a+?b$/, 'aab'],
      [/^[-a]$/, '-'],
      [/^[\]]$/, ']'],
      [/^\D$/, 'x'],
      [/^\D$/, '4'],
      [/^é$/, 'é'],
      [/^[^é]$/, 'a'],
      [/^\d$/, '٣'],
      [/^[a-z]+$/i, 'ABC'],
      [/^[a-z]+$/i, 'ÉÉ'],
      [/^k$/i, 'K'],
    ];
    for (const [pattern, value] of agreeing) {
      const server = await rawMatch(pattern.source, value);
      // The OPERATOR the flags choose is part of the meaning, so the emitted form is what runs:
      // `~` and `~*` are two different questions over one source.
      const framework = await client
        .query<{ m: boolean | null }>(
          sql`select (${raw(emittedSql(pattern))}) as m from (select ${value}::text as value) probe`,
        )
        .then((rows) => rows[0]?.m === true);
      expect([pattern.source, value, framework]).toEqual([
        pattern.source,
        value,
        inTypeScript(pattern, value),
      ]);
      // The case-sensitive read is the same source without the flag, and it is reported so a
      // disagreement here is not silently absorbed by `~*`.
      if (pattern.flags === '') {
        expect([pattern.source, value, server]).toEqual([pattern.source, value, framework]);
      }
    }
  });
});
