// The read-transaction helper and its one setting seam: `set_config` is sent from `local-settings.ts`
// alone, a bounded read under `withReplicaReads` never reaches the replica, and inside an open
// transaction the prior values come back. Over recording clients — statement order is the claim.

import { describe, expect, test } from 'bun:test';
import { Glob } from 'bun';
import { recordingClient } from './fake';
import { reservableOver } from './fake-reservable-fixture';
import { withReadTransaction } from './read-transaction';
import { replicatedClient } from './replica-client';
import { withReplicaReads } from './replica-scope';
import { sql } from './sql';
import { withStatementTimeout } from './statement-bound';
import { withTransaction } from './transaction';

const SET = /select set_config\(\$1, \$2, true\)/;

describe('the one set_config caller', () => {
  test('no framework source file but local-settings.ts sends set_config(', async () => {
    const root = Bun.fileURLToPath(new URL('../../', import.meta.url));
    const callers: string[] = [];
    for await (const path of new Glob('*/src/**/*.ts').scan({ cwd: root })) {
      if (/\.(test|live\.test|contract\.test)\.ts$/.test(path)) continue;
      const text = await Bun.file(`${root}${path}`).text();
      // A call in a SQL template — never a name in a list or a comment, which `mcp`'s guard holds.
      if (/sql`[^`]*set_config\(/.test(text) || /raw\([^)]*set_config\(/.test(text)) {
        callers.push(path);
      }
    }
    expect(callers).toEqual(['db/src/local-settings.ts']);
  });

  test('no framework source file sends SET [LOCAL] statement_timeout as text', async () => {
    // The second path a time bound took: spliced `SET LOCAL` text beside `setLocal`'s bound one.
    const root = Bun.fileURLToPath(new URL('../../', import.meta.url));
    const spliced = /(?:sql`|raw\(\s*[`'"])\s*set\s+(?:local\s+)?statement_timeout\b/i;
    const senders: string[] = [];
    for await (const path of new Glob('*/src/**/*.ts').scan({ cwd: root })) {
      if (/\.test\.ts$/.test(path)) continue;
      if (spliced.test(await Bun.file(`${root}${path}`).text())) senders.push(path);
    }
    expect(senders).toEqual([]);
  });
});

describe('withReadTransaction', () => {
  test('outside a transaction: BEGIN READ ONLY, the settings, the read, COMMIT', async () => {
    const pool = recordingClient();
    await withReadTransaction((tx) => tx.query(sql`select 1`), {
      client: pool,
      settings: { 'x.tenant': 'org_1' },
    });
    expect(pool.texts).toEqual([
      'BEGIN READ ONLY',
      'select set_config($1, $2, true)',
      'select 1',
      'COMMIT',
    ]);
    expect(pool.statements[1]?.values).toEqual(['x.tenant', 'org_1']);
  });

  test('inside one: joins it, sets, reads, and puts the prior value back', async () => {
    const pool = recordingClient().on(/current_setting/, { rows: [{ value: 'org_0' }] });
    await withTransaction(
      () =>
        withReadTransaction((tx) => tx.query(sql`select 1`), {
          settings: { 'x.tenant': 'org_1' },
        }),
      { client: pool },
    );
    expect(pool.texts.filter((text) => SET.test(text)).length).toBe(2);
    expect(pool.statements.at(-2)?.values).toEqual(['x.tenant', 'org_0']);
    expect(pool.texts.at(-1)).toBe('COMMIT');
  });
});

describe('withStatementTimeout', () => {
  test('under withReplicaReads it runs on the primary, never the replica', async () => {
    const primary = recordingClient().on(/pg_settings/, { rows: [{ ms: '10000' }] });
    const { client: pinned, pins } = reservableOver(primary);
    const replica = recordingClient();
    const pair = replicatedClient(pinned, replica);
    await withReplicaReads(() =>
      withStatementTimeout(500, (tx) => tx.query(sql`select * from posts`), { client: pair }),
    );
    expect(replica.texts).toEqual([]);
    expect(primary.texts).toContain('select * from posts');
    expect(pins).toEqual({ reserves: 1, releases: 1 });
    const bound = primary.statements.find((statement) => SET.test(statement.text));
    expect(bound?.values).toEqual(['statement_timeout', '500']);
  });

  test('refuses a bound above the one in force, and a non-positive one, before any read', async () => {
    const pool = recordingClient().on(/pg_settings/, { rows: [{ ms: '10000' }] });
    const run = (ms: number) =>
      withStatementTimeout(ms, (tx) => tx.query(sql`select 1`), { client: pool });
    for (const ms of [0, -1, 1.5, Number.NaN, 10_001]) {
      await expect(run(ms)).rejects.toMatchObject({ code: 'X_DB_STATEMENT_BOUND_INVALID' });
    }
    expect(pool.texts).not.toContain('select 1');
  });

  test('a role with no bound (0) accepts any bound', async () => {
    const pool = recordingClient().on(/pg_settings/, { rows: [{ ms: '0' }] });
    await withStatementTimeout(60_000, (tx) => tx.query(sql`select 1`), { client: pool });
    expect(pool.texts).toContain('select 1');
  });
});
