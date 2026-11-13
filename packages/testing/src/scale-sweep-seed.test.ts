// The sized seed, table by table: a refusal loses its table and every table pointing at it, the
// others are written; a reader is one whose own statements named a lost table, as an identifier.

import { describe, expect, test } from 'bun:test';
import { entity, text, uuid } from '@ultimat3/entity';
import type { SentStatement } from './plan-sweep';
import { readsLost, writeSizedSeeds } from './scale-sweep-seed';
import { seedGraph } from './seed-graph';
import type { SeedRow, SeedWriter } from './seed-graph-plan';
import { testName } from './test-types';

const orgs = entity('sss_orgs', { columns: { id: uuid().primaryKey(), name: text({ max: 40 }) } });
const posts = entity('sss_posts', {
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
});
