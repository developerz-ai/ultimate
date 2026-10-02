// Single responsibility: every `unexpected-object` fix is a line a real shell and a real `psql`
// run — one object of each kind, made by hand on a server, and its rendered fix executed as
// written. Skips unless `TEST_DATABASE_URL` is set and `psql` is installed.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type CatalogDescription, emptyCatalog } from './catalog';
import { createPostgresClient, type PostgresClient } from './client';
import { unexpectedObjects } from './object-drift';
import { raw } from './sql';

const url = Bun.env['TEST_DATABASE_URL'];
const runnable = typeof url === 'string' && url.length > 0 && Bun.which('psql') !== null;
const SCHEMA = 'objdrift_schema';

/** What the catalog would describe once the statements below have run. */
const live: CatalogDescription = {
  ...emptyCatalog(SCHEMA),
  types: [{ kind: 'enum', name: 'od_mood', labels: ['ok'] }],
  sequences: [
    {
      name: 'od_seq',
      dataType: 'bigint',
      start: '1',
      increment: '1',
      min: '1',
      max: '9',
      cache: '1',
      cycle: false,
    },
  ],
  views: [
    { name: 'od_report', materialized: false, options: null, definition: '' },
    { name: 'od_totals', materialized: true, options: null, definition: '' },
  ],
  functions: [
    { name: 'od_touch', arguments: '', definition: '' },
    { name: 'od_label', arguments: 'a text', definition: '' },
  ],
  triggers: [{ table: 'od_posts', name: 'od_posts_touch', definition: '', enabled: 'O' }],
};

const SETUP = [
  `create type od_mood as enum ('ok')`,
  'create sequence od_seq maxvalue 9',
  'create table od_posts (id int)',
  'create view od_report as select id from od_posts',
  'create materialized view od_totals as select count(*) as n from od_posts',
  `create function od_touch() returns trigger language plpgsql as 'begin return new; end'`,
  `create function od_label(a text default 'x') returns text language sql as 'select a'`,
  'create trigger od_posts_touch before update on od_posts for each row execute function od_touch()',
];

describe.skipIf(!runnable)('live · postgres · an unexpected-object fix runs as written', () => {
  let admin: PostgresClient;

  /** The line, through `sh`, against this file's schema: its exit code and what it printed. */
  const run = async (line: string): Promise<readonly [number, string, string]> => {
    const shell = Bun.spawn(['sh', '-c', line], {
      // `PGOPTIONS`, not the URL: libpq reads the `+` a URL encoder writes for a space literally.
      env: { ...Bun.env, DATABASE_URL: url ?? '', PGOPTIONS: `-c search_path=${SCHEMA}` },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [out, err] = await Promise.all([
      new Response(shell.stdout).text(),
      new Response(shell.stderr).text(),
    ]);
    return [await shell.exited, out, err];
  };

  beforeAll(async () => {
    admin = createPostgresClient({ url: url ?? '' });
    await admin.execute(raw(`drop schema if exists "${SCHEMA}" cascade`));
    await admin.execute(raw(`create schema "${SCHEMA}"`));
    for (const statement of SETUP) {
      await admin.execute(raw(`set search_path = "${SCHEMA}"; ${statement}`));
    }
  });

  afterAll(async () => {
    await admin.execute(raw(`drop schema if exists "${SCHEMA}" cascade`));
    await admin.close();
  });

  test('each kind: the command exits 0 and prints the object it names', async () => {
    const differences = unexpectedObjects(live, emptyCatalog(SCHEMA));
    expect(differences).toHaveLength(7);
    for (const difference of differences) {
      const [code, out, err] = await run(difference.fix);
      expect([difference.cause, code, err]).toEqual([difference.cause, 0, '']);
      // The definition a migration would be copied from is on the screen.
      expect(out.length, difference.cause).toBeGreaterThan(0);
    }
  });

  test('the trigger is shown on its table, and the function with the body it has', async () => {
    const fixOf = (needle: string): string =>
      unexpectedObjects(live, emptyCatalog(SCHEMA)).find((one) => one.cause.includes(needle))
        ?.fix ?? '';
    expect((await run(fixOf('trigger')))[1]).toContain('od_posts_touch');
    expect((await run(fixOf('"od_label"')))[1]).toContain('CREATE OR REPLACE FUNCTION');
  });

  test('and the drop the comment names is a statement the server accepts', async () => {
    const fix = unexpectedObjects(live, emptyCatalog(SCHEMA)).find((one) =>
      one.cause.includes('trigger'),
    )?.fix;
    const drop = /run (drop trigger [^;]+;) here/.exec(fix ?? '')?.[1];
    expect(drop).toBe('drop trigger "od_posts_touch" on "od_posts";');
    await admin.execute(raw(`set search_path = "${SCHEMA}"; ${drop ?? ''}`));
  });
});
