// Single responsibility: pin the partitioned-table recipe in `wiki/Migrations-And-Backfills.md` —
// the job's SQL runs as written, twice for next month (a double fire is a no-op), drift stays clean
// throughout, and a reference into the table can only be the hand-written composite key the page
// names: a one-column key is `42830`, a same-tenant key's unique index `0A000`.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
// why: Bun ships no path joiner, and the wiki page is found relative to this file.
import { join } from 'node:path';
import { checkDrift } from './drift';
import { findTable, introspectSchema } from './introspect';
import { migrate } from './migrate';
import { CREATE_EVENTS } from './partitioned-fixture';
import { pgliteClient } from './pglite';
import { raw } from './sql';
import { sqlState } from './sqlstate';
import { statementsOf } from './statement-split';

const PGLITE_BOOT_MS = 60_000;
const PAGE = join(import.meta.dir, '../../../wiki/Migrations-And-Backfills.md');

/** The page's one `sql` fence under `## Partitioned tables`, split at its two comment lines. */
async function recipe(): Promise<{ readonly next: string; readonly retention: string }> {
  const page = await Bun.file(PAGE).text();
  const section = page.slice(page.indexOf('## Partitioned tables'));
  const fence = /```sql\n([\s\S]*?)```/.exec(section)?.[1] ?? '';
  const [next = '', retention = ''] = fence.split(/^-- retention.*$/m);
  return { next, retention };
}

describe('the partitioned-table recipe, as the wiki writes it', () => {
  const client = pgliteClient();
  const migrations = [CREATE_EVENTS];
  const run = async (script: string): Promise<void> => {
    for (const statement of statementsOf(script)) await client.execute(raw(statement));
  };
  const refusal = (statement: string): Promise<string | undefined> =>
    client.execute(raw(statement)).then(
      () => undefined,
      (error: unknown) => sqlState(error),
    );

  beforeEach(async () => {
    await client.execute(raw('drop schema public cascade'));
    await client.execute(raw('create schema public'));
    await migrate({ migrations, appVersion: 'test', client });
  }, PGLITE_BOOT_MS);

  afterAll(async () => {
    await client.close();
  });

  test('next month runs twice as a no-op; retention detaches and drops; drift stays clean', async () => {
    const { next, retention } = await recipe();
    expect(statementsOf(next)).toHaveLength(1);
    expect(statementsOf(retention)).toHaveLength(2);
    await run(next);
    await run(next);
    expect(await checkDrift({ migrations, client })).toEqual({ ok: true, differences: [] });
    await run(retention);
    expect(await checkDrift({ migrations, client })).toEqual({ ok: true, differences: [] });
    const left = await client.query<{ name: string }>(
      raw(`select relname as name from pg_class where relname like 'events_%' and relkind = 'r'`),
    );
    expect(left.map((row) => row.name)).toEqual(['events_2026_12']);
  });

  test('a reference into it: one column is 42830, a same-tenant index 0A000, composite applies', async () => {
    await run('create table notes (id uuid primary key, event_id uuid, event_at timestamp)');
    expect(
      await refusal('alter table notes add foreign key (event_id) references events (id)'),
    ).toBe('42830');
    expect(await refusal('create unique index events_kind_id_key on events (kind, id)')).toBe(
      '0A000',
    );
    await run(
      'alter table "notes" add constraint "notes_event_fkey" foreign key ("event_id", "event_at") ' +
        'references "events" ("id", "at")',
    );
    const notes = findTable(await introspectSchema({ client }), 'notes');
    expect(notes?.foreignKeys.map((key) => key.name)).toEqual(['notes_event_fkey']);
  });
});
