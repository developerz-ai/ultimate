// The sized seed, table by table: a refusal loses its table and every table pointing at it, the
// others are written; a reader is one whose own statements named a lost table, as an identifier.

import { describe, expect, test } from 'bun:test';
import { bigint, entity, text, uuid } from '@ultimat3/entity';
import type { SentStatement } from './plan-sweep';
import { readsLost, writeSizedSeeds } from './scale-sweep-seed';
import { seedGraph } from './seed-graph';
import type { SeedRow, SeedWriter } from './seed-graph-plan';
import { testName } from './test-types';

const orgs = entity('sss_orgs', { columns: { id: uuid().primaryKey(), name: text({ max: 40 }) } });
const posts = entity('sss_posts', {
  history: true,
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid()
      .references(() => orgs.id)
      .tenant(),
    title: text({ max: 40 }),
  },
});
const comments = entity('sss_comments', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid()
      .references(() => orgs.id)
      .tenant(),
    postId: uuid().references(() => posts.id),
    body: text({ max: 40 }),
  },
});
const notes = entity('sss_notes', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid()
      .references(() => orgs.id)
      .tenant(),
    body: text({ max: 40 }),
  },
});
const entities = [orgs, posts, comments, notes];

/** Refuses every `sss_posts` row, as a unique index would; records what it was sent. */
const refusingPosts = (): SeedWriter & { readonly sent: string[] } => {
  const sent: string[] = [];
  return {
    sent,
    insert: async (row: SeedRow) => {
      if (row.entity === 'sss_posts') {
        // Input to the code under test, as the driver's refusal is: never this test's verdict.
        const refusal = new TypeError(
          'duplicate key value violates unique constraint "sss_posts_title"',
        );
        throw refusal;
      }
      sent.push(row.entity);
    },
    update: async () => {},
    snapshot: async (rows) => rows.map(() => null),
  };
};

describe(testName('unit', 'writeSizedSeeds'), () => {
  const graph = () => seedGraph({ orgs, posts, comments, notes }, { tenants: 1, seed: 3 });

  test('one refusal per table; a table pointing at it is skipped, the rest are written', async () => {
    const writer = refusingPosts();
    const loss = await writeSizedSeeds([graph(), graph()], entities, writer);
    expect(loss.failures.map((one) => one.entity)).toEqual(['sss_posts']);
    expect(loss.failures[0]?.cause).toContain('sss_posts_title');
    expect([...loss.lost.keys()].sort()).toEqual(['sss_comments', 'sss_posts']);
    expect(loss.lost.get('sss_comments')?.entity).toBe('sss_posts');
    expect(new Set(writer.sent)).toEqual(new Set(['sss_orgs', 'sss_notes']));
  });

  test('a reader is one whose own statement names the lost table, never a longer name', async () => {
    const loss = await writeSizedSeeds([graph()], entities, refusingPosts());
    const sent = new Map<string, SentStatement>([
      ['select * from "sss_posts" where "orgId" = $1', { primitives: new Set(['listPosts']) }],
      ['select * from "sss_posts_archive"', { primitives: new Set(['archive']) }],
      ['select * from sss_comments', { primitives: new Set(['thread']) }],
      ['select * from "sss_notes"', { primitives: new Set(['listNotes']) }],
    ]);
    expect(readsLost('listPosts', sent, loss, entities)?.entity).toBe('sss_posts');
    expect(readsLost('thread', sent, loss, entities)?.entity).toBe('sss_posts');
    expect(readsLost('archive', sent, loss, entities)).toBeUndefined();
    expect(readsLost('listNotes', sent, loss, entities)).toBeUndefined();
  });

  test('a column named like a lost table is no read of it: only a table position is', async () => {
    const loss = await writeSizedSeeds([graph()], entities, refusingPosts());
    const sent = new Map<string, SentStatement>([
      ['select "sss_posts" from "sss_notes"', { primitives: new Set(['column']) }],
      ['update "sss_notes" set "sss_posts" = 1', { primitives: new Set(['set']) }],
      ['select * from "sss_notes" n, "sss_posts" p', { primitives: new Set(['comma']) }],
    ]);
    expect(readsLost('column', sent, loss, entities)).toBeUndefined();
    expect(readsLost('set', sent, loss, entities)).toBeUndefined();
    expect(readsLost('comma', sent, loss, entities)?.entity).toBe('sss_posts');
  });

  test('a view or a history table over a lost table is read as the lost table', async () => {
    const totals = entity('sss_post_totals', {
      view: { sql: 'select org_id, count(*) as total from sss_posts group by org_id' },
      columns: { orgId: uuid().tenant(), total: bigint() },
      primaryKey: ['orgId'],
    });
    const rollup = entity('sss_rollup', {
      view: { sql: 'select org_id, total from sss_post_totals' },
      columns: { orgId: uuid().tenant(), total: bigint() },
      primaryKey: ['orgId'],
    });
    const history = posts.$history ?? expect.unreachable('history: true declares a history entity');
    // The view over a view first: one pass in declaration order would not reach it.
    const all = [...entities, rollup, totals, history];
    const loss = await writeSizedSeeds([graph()], all, refusingPosts());
    const sent = new Map<string, SentStatement>([
      ['select * from "sss_post_totals"', { primitives: new Set(['totals']) }],
      ['select * from "sss_rollup"', { primitives: new Set(['rollup']) }],
      [`select * from "${history.$table}"`, { primitives: new Set(['audit']) }],
    ]);
    expect(readsLost('totals', sent, loss, all)?.entity).toBe('sss_posts');
    expect(readsLost('rollup', sent, loss, all)?.entity).toBe('sss_posts');
    expect(readsLost('audit', sent, loss, all)?.entity).toBe('sss_posts');
  });
});
