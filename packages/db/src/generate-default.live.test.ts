// Single responsibility: a column DEFAULT an app declared, generated and then applied to a real
// server under BOTH settings of `standard_conforming_strings`. The default is the one value in a
// generated migration that is an app's own text — `column-default.ts:43` renders
// `ColumnDefaultLike` through `literal()`, nothing validates it and no `identifier()` guards it —
// and `literal()` doubled the quote and nothing else until 2026-08-25.
//
// Measured on 18.4 before the fix: `.default('C:\\logs')` emitted `default 'C:\logs'`, which the
// server stored as `C:\logs` with the GUC on and as **`C:logs`** with it off. A declaration that
// type-checks, a migration that applies, and a column defaulting to a value nobody wrote — no
// error anywhere. Only a real server can tell the two readings apart, which is why this file
// inserts a row rather than comparing strings.
//
// `SET` on that GUC needs no privilege and it is settable per database and per role, so "the
// default has been `on` since 9.1" is not a guarantee the framework may rest on.
//
// The first describe needs no server: it asks whether this package's own lexer still reads what
// its escape writes, which is a property of the generated TEXT and must not go unchecked in a CI
// with nothing listening.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createPostgresClient, type PostgresClient } from './client';
import type { ColumnDescriptionLike, EntityDescriptionLike } from './entity-shape';
import { generateMigration } from './generate';
import { raw } from './sql';
import { statementsOf } from './statement-split';

const url = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof url === 'string' && url.length > 0;

const TABLE = 'cd_paths';
/** A Windows path is the everyday spelling of this; a regex or a TeX snippet is the same value. */
const WINDOWS_PATH = 'C:\\logs';

const column = (
  name: string,
  overrides: Partial<ColumnDescriptionLike> = {},
): ColumnDescriptionLike => ({
  property: name,
  column: name,
  kind: 'text',
  notNull: false,
  primaryKey: false,
  unique: false,
  hasDefault: false,
  check: null,
  references: null,
  ...overrides,
});

const paths = (value: string): EntityDescriptionLike => ({
  name: 'CdPath',
  table: TABLE,
  primaryKey: ['id'],
  columns: [
    column('id', { kind: 'uuid', primaryKey: true, notNull: true }),
    column('path', { hasDefault: true, default: { kind: 'value', value } }),
  ],
  indexes: [],
});

const at = new Date('2026-08-25T00:00:00.000Z');
const upFor = (value: string): string =>
  generateMigration({ entities: [paths(value)], name: 'init', now: at }).up;

describe('a generated default carrying a backslash', () => {
  test('is emitted as an E-string, so the statement says which dialect it means', () => {
    expect(upFor(WINDOWS_PATH)).toContain("default E'C:\\\\logs'");
  });

  test('a default carrying none is byte-identical to what the generator always emitted', () => {
    // Load-bearing: both tracked apps hold applied migrations whose `.hash` covers this text.
    expect(upFor('draft')).toContain("default 'draft'");
    expect(upFor('draft')).not.toContain("default E'");
  });

  // `create table` is ONE statement, and `migrate()` sends `statementsOf(script)` one at a time —
  // so a default whose escape the lexer misread would be sent as two commands, or refused by
  // `multipleStatements`. The semicolon and the quote together are the shape that tells a correct
  // E-string from one whose backslashes were not doubled.
  test('statementsOf still sees one statement, semicolon and quote inside the value', () => {
    const script = upFor("a\\'b; drop table posts; --");
    expect(statementsOf(script)).toHaveLength(1);
    expect(statementsOf(script)[0]).toContain('drop table posts');
  });
});

describe.skipIf(!hasPostgres)('live · postgres · a default under both GUC settings', () => {
  let client: PostgresClient;

  const teardown = async (): Promise<void> => {
    await client.execute(raw(`drop table if exists "${TABLE}" cascade`));
  };

  beforeAll(async () => {
    client = createPostgresClient({ url: url ?? '' });
    await teardown();
  });

  afterAll(async () => {
    await teardown();
    // The GUC is per session and this pool's connections outlive the test otherwise.
    await client.execute(raw('set standard_conforming_strings = on'));
    await client.close();
  });

  /** Apply the generated migration under `setting`, insert a row, and read the default back. */
  const storedUnder = async (setting: 'on' | 'off'): Promise<string> => {
    await teardown();
    await client.execute(raw(`set standard_conforming_strings = ${setting}`));
    for (const statement of statementsOf(upFor(WINDOWS_PATH))) {
      await client.execute(raw(statement));
    }
    await client.execute(raw(`insert into "${TABLE}" ("id") values (gen_random_uuid())`));
    const rows = await client.query<{ path: string }>(raw(`select "path" from "${TABLE}"`));
    return rows[0]?.path ?? '';
  };

  test('the column defaults to the value the entity declared, whatever the session says', async () => {
    expect(await storedUnder('on')).toBe(WINDOWS_PATH);
    // The half that was broken: `C:logs`, silently, because `\l` was read as an escape.
    expect(await storedUnder('off')).toBe(WINDOWS_PATH);
  });
});
