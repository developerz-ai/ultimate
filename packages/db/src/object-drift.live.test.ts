// Single responsibility: every `unexpected-object` fix is a line a real shell and a real `psql`
// run — one object of each kind, made by hand in a schema the session's search_path does NOT
// hold, read back through `introspectCatalog`, and its rendered fix executed as written. Skips
// unless `TEST_DATABASE_URL` is set and `psql` is installed.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type CatalogDescription, emptyCatalog } from './catalog';
import { createPostgresClient, type PostgresClient } from './client';
import { introspectCatalog } from './introspect-catalog';
import { unexpectedObjects } from './object-drift';
import { raw } from './sql';

const url = Bun.env['TEST_DATABASE_URL'];
const runnable = typeof url === 'string' && url.length > 0 && Bun.which('psql') !== null;
const SCHEMA = 'objdrift_schema';
const S = `"${SCHEMA}"`;

const SETUP = [
  `create type ${S}.od_mood as enum ('fine', 'grim')`,
  `create domain ${S}.od_email as text check (value like '%@%')`,
  `create sequence ${S}.od_seq maxvalue 9`,
  `create table ${S}.od_posts (id int)`,
  `create view ${S}.od_report as select id as report_id from ${S}.od_posts`,
  `create materialized view ${S}.od_totals as select count(*) as total_n from ${S}.od_posts`,
  `create function ${S}.od_touch() returns trigger language plpgsql as 'begin return new; end'`,
  // An argument of the schema's OWN type, so its identity arguments are spelled by search_path.
  `create function ${S}.od_label(a text, m ${S}.od_mood) returns text language sql as 'select a || ''-here'''`,
  `create trigger od_posts_touch before update on ${S}.od_posts for each row execute function ${S}.od_touch()`,
  // The decoy: same name and arguments in a schema the session DOES see.
  `create function public.od_touch() returns trigger language plpgsql as 'begin return null; end'`,
];

/** What each kind's command must put on the screen: the thing a migration would be copied from. */
const SHOWS: Readonly<Record<string, string>> = {
  'type "od_mood"': 'grim',
  'domain "od_email"': 'CHECK',
  'sequence "od_seq"': 'bigint',
  'view "od_report"': 'report_id',
  'materialized view "od_totals"': 'total_n',
  'function "od_touch"': 'return new',
  'function "od_label"': '-here',
  'trigger "od_posts_touch"': 'od_posts_touch',
};

describe.skipIf(!runnable)('live · postgres · an unexpected-object fix runs as written', () => {
  let admin: PostgresClient;
  let live: CatalogDescription;

  /** The line, through `sh`, with NOTHING putting the schema on the search_path. */
  const run = async (line: string): Promise<readonly [number, string, string]> => {
    const shell = Bun.spawn(['sh', '-c', line], {
      env: { ...Bun.env, DATABASE_URL: url ?? '', PGOPTIONS: '' },
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
    await admin.execute(raw(`drop schema if exists ${S} cascade`));
    await admin.execute(raw('drop function if exists public.od_touch()'));
    await admin.execute(raw(`create schema ${S}`));
    for (const statement of SETUP) await admin.execute(raw(statement));
    live = await introspectCatalog({ client: admin, schema: SCHEMA });
  });

  afterAll(async () => {
    await admin.execute(raw(`drop schema if exists ${S} cascade`));
    await admin.execute(raw('drop function if exists public.od_touch()'));
    await admin.close();
  });

  test('each kind: the command exits 0, says nothing on stderr, and prints its definition', async () => {
    const differences = unexpectedObjects(live, emptyCatalog(SCHEMA));
    const seen: string[] = [];
    for (const difference of differences) {
      const subject = Object.keys(SHOWS).find((key) => difference.cause.startsWith(key));
      if (subject === undefined) continue;
      seen.push(subject);
      const [code, out, err] = await run(difference.fix);
      // `\d` on a name it cannot find exits 0 and complains on stderr — so stderr is the verdict.
      expect([subject, code, err]).toEqual([subject, 0, '']);
      expect(out, subject).toContain(SHOWS[subject] ?? '');
    }
    expect(seen.sort()).toEqual(Object.keys(SHOWS).sort());
  });

  test('the function shown is the schema’s own, never a same-named one the session can see', async () => {
    const fix = unexpectedObjects(live, emptyCatalog(SCHEMA)).find((one) =>
      one.cause.startsWith('function "od_touch"'),
    )?.fix;
    const [, out] = await run(fix ?? '');
    expect(out).toContain('return new');
    expect(out).not.toContain('return null');
  });

  test('and the drop each comment names is a statement the server accepts', async () => {
    const drops = unexpectedObjects(live, emptyCatalog(SCHEMA))
      .map((one) => / run (drop [^;]+;) here/.exec(one.fix)?.[1])
      .filter((drop): drop is string => drop !== undefined);
    expect(drops).toContain(`drop domain ${S}."od_email";`);
    expect(drops).toContain(`drop trigger "od_posts_touch" on ${S}."od_posts";`);
    // Dependants first: the trigger before its function, the views before the table's column.
    const order = [
      'trigger',
      'materialized view',
      'view',
      'function',
      'domain',
      'type',
      'sequence',
    ];
    const ranked = [...drops].sort(
      (a, b) =>
        order.findIndex((kind) => a.startsWith(`drop ${kind} `)) -
        order.findIndex((kind) => b.startsWith(`drop ${kind} `)),
    );
    for (const drop of ranked) await admin.execute(raw(drop));
  });
});
