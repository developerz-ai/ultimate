// A foreign key on a live table, applied by the real runner under real writes. The numbers that
// asked for this: 188 ms of stalled inserts on a RAM disk as `x db gen` wrote the key, 1 ms as
// `not valid` then `validate`. These pin the order and its failure modes; a server is what can.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { isUltimateError, probeDatabaseName } from '@ultimat3/core';
import { type PostgresClient, postgresClient } from './client';
import { checkDrift } from './drift';
import type { EntityDescriptionLike } from './entity-shape';
import { type GeneratedMigration, generateMigration } from './generate';
import type { SchemaDescription } from './introspect';
import { type Migration, migrate, rollback } from './migrate';
import { AT, tableOf, textColumn, uuidColumn } from './rolling-fixture';
import { raw } from './sql';

const url = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof url === 'string' && url.length > 0;
const SCRATCH = probeDatabaseName('ult_fkonline');

const posts = tableOf('fo_posts');
const bare = tableOf('fo_comments', [uuidColumn('post_id')]);
const keyed = (onDelete: string | null = null): EntityDescriptionLike =>
  tableOf('fo_comments', [uuidColumn('post_id', { references: 'fo_posts.id', onDelete })]);
const ORPHAN = '00000000-0000-4000-8000-000000000001';
const POST = '00000000-0000-4000-8000-000000000002';

describe.skipIf(!hasPostgres)('live · a foreign key added online', () => {
  let admin: PostgresClient;
  let client: PostgresClient;
  const applied: Migration[] = [];

  beforeAll(async () => {
    admin = postgresClient({ url: url ?? '' });
    await admin.execute(raw(`create database "${SCRATCH}"`));
    const scoped = new URL(url ?? '');
    scoped.pathname = `/${SCRATCH}`;
    client = postgresClient({ url: scoped.toString() });
  });

  afterAll(async () => {
    await client.close();
    await admin.execute(raw(`drop database "${SCRATCH}" with (force)`));
    await admin.close();
  });

  const reset = async (): Promise<void> => {
    applied.length = 0;
    await client.execute(raw('drop table if exists fo_comments, fo_posts, fo_orgs, x_migrations'));
  };
  beforeEach(reset);
  afterEach(reset);

  /** Every file `x db gen` would write for one diff, in the order the ledger takes them. */
  const stepsOf = (id: string, generated: GeneratedMigration): readonly Migration[] => {
    const one = (step: GeneratedMigration, stepId: string): Migration => ({
      id: stepId,
      name: step.name,
      up: step.up,
      down: step.down,
      snapshot: step.snapshot,
    });
    return [
      one(generated, id),
      ...(generated.followUp === undefined ? [] : [one(generated.followUp, `${id}_concurrently`)]),
    ];
  };

  const apply = async (id: string, generated: GeneratedMigration) => {
    applied.push(...stepsOf(id, generated));
    return migrate({ migrations: applied, client, appVersion: 'test' });
  };

  const init = async (entities: readonly EntityDescriptionLike[]): Promise<SchemaDescription> => {
    const generated = generateMigration({ entities, name: 'init', now: AT });
    await apply('1_init', generated);
    return generated.snapshot;
  };

  const validated = async (name: string): Promise<boolean | undefined> => {
    const rows = await client.query<{ convalidated: boolean }>(
      raw(`select convalidated from pg_constraint where conname = '${name}'`),
    );
    return rows[0]?.convalidated;
  };

  test('a key whose index the same step builds applies with no 42830', async () => {
    const plain = tableOf('fo_posts', [uuidColumn('slug')]);
    const current = await init([bare, plain]);
    const indexed = tableOf('fo_posts', [uuidColumn('slug')], {
      indexes: [
        {
          name: 'fo_posts_slug_key',
          columns: ['slug'],
          unique: true,
          where: null,
          order: null,
          concurrently: true,
        },
      ],
    });
    const child = tableOf('fo_comments', [uuidColumn('post_id', { references: 'fo_posts.slug' })]);
    await apply(
      '2_link',
      generateMigration({ entities: [child, indexed], current, name: 'l', now: AT }),
    );
    expect(await validated('fo_comments_post_id_fkey')).toBe(true);
    expect((await checkDrift({ migrations: applied, client })).differences).toEqual([]);
    // Reversed in the mirror order: the index cannot go while the key still needs it.
    await rollback({ migrations: applied, client, steps: 1 });
    const left = await client.query(
      raw(`select 1 from pg_constraint where conname = 'fo_comments_post_id_fkey'`),
    );
    expect(left).toEqual([]);
  });

  test('an orphan fails validate, drift reports the state, and a re-run after repair passes', async () => {
    const current = await init([bare, posts]);
    await client.execute(
      raw(`insert into fo_comments (id, post_id) values (gen_random_uuid(), '${ORPHAN}')`),
    );
    const generated = generateMigration({
      entities: [keyed(), posts],
      current,
      name: 'k',
      now: AT,
    });
    let code = 'resolved';
    try {
      await apply('2_key', generated);
    } catch (error) {
      code = isUltimateError(error) ? error.code : 'not an UltimateError';
    }
    expect(code).toBe('X_DB_FOREIGN_KEY_VIOLATION');
    // The key holds every new write already; only the old row is unchecked.
    expect(await validated('fo_comments_post_id_fkey')).toBe(false);
    const insert = client.execute(
      raw(`insert into fo_comments (id, post_id) values (gen_random_uuid(), '${ORPHAN}')`),
    );
    await expect(insert).rejects.toMatchObject({ code: 'X_DB_FOREIGN_KEY_VIOLATION' });

    // The ledger holds only `1_init`, which declares no key, so nothing is owed yet.
    const report = await checkDrift({ migrations: applied, client });
    expect(report.differences).toEqual([]);
    // Once a ledger row claims the key, as after a hand-marked step, the state is a finding.
    const claimed = await checkDrift({
      migrations: [{ ...(applied.at(-1) as Migration), id: applied[0]?.id ?? '' }],
      client,
    });
    const kinds = claimed.differences.map((each) => each.kind);
    expect(kinds).toContain('not-valid-constraint');
    const finding = claimed.differences.find((each) => each.kind === 'not-valid-constraint');
    expect(finding?.fix).toContain('validate constraint');

    // Repair the row, re-run: the step runs again from its top, and finishes.
    await client.execute(raw(`delete from fo_comments`));
    const report2 = await migrate({ migrations: applied, client, appVersion: 'test' });
    expect(report2.applied.map((each) => each.id)).toEqual(['2_key']);
    expect(await validated('fo_comments_post_id_fkey')).toBe(true);
  });

  test('the old key holds throughout a swap, under concurrent writes', async () => {
    const orgs = tableOf('fo_orgs');
    const current = await init([keyed(), posts, orgs]);
    await client.execute(raw(`insert into fo_posts (id) values ('${POST}')`));
    // A row under the old key's rule, held by an old-key target: every write below must pass or
    // be refused by a key, never slip through a moment with none.
    let writing = true;
    const accepted: string[] = [];
    const writer = (async () => {
      while (writing) {
        await client
          .execute(
            raw(`insert into fo_comments (id, post_id) values (gen_random_uuid(), '${ORPHAN}')`),
          )
          .then(() => accepted.push('orphan'))
          .catch(() => undefined);
        await Bun.sleep(0);
      }
    })();
    const moved = generateMigration({
      entities: [keyed('cascade'), posts, orgs],
      current,
      name: 'c',
      now: AT,
    });
    await apply('2_rule', moved);
    writing = false;
    await writer;
    expect(accepted).toEqual([]);
    expect(await validated('fo_comments_post_id_fkey')).toBe(true);
    expect((await checkDrift({ migrations: applied, client })).differences).toEqual([]);
  });

  test('a CHECK is not valid in the transaction, validated after, and a bad row is named', async () => {
    const titled = tableOf('fo_posts', [textColumn('title')]);
    const current = await init([titled]);
    await client.execute(raw(`insert into fo_posts (id, title) values (gen_random_uuid(), '')`));
    const checked = tableOf('fo_posts', [textColumn('title', { check: 'length(title) > 0' })]);
    const generated = generateMigration({ entities: [checked], current, name: 'c', now: AT });
    let thrown = false;
    await apply('2_check', generated).catch(() => {
      thrown = true;
    });
    expect(thrown).toBe(true);
    expect(await validated('fo_posts_title_check')).toBe(false);
    const report = await checkDrift({ migrations: applied.slice(0, 2), client });
    expect(report.differences.map((each) => each.kind)).toEqual(['not-valid-constraint']);
    await client.execute(raw('delete from fo_posts'));
    await migrate({ migrations: applied, client, appVersion: 'test' });
    expect(await validated('fo_posts_title_check')).toBe(true);
    expect((await checkDrift({ migrations: applied, client })).ok).toBe(true);
  });
});
