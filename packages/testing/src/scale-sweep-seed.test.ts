// The sized seed, table by table: a refusal loses its table and every table pointing at it, the
// others are written; a reader is one whose own statements named a lost table, as an identifier.

import { describe, expect, test } from 'bun:test';
import { bigint, entity, text, uuid } from '@ultimat3/entity';
import type { SentStatement } from './plan-sweep';
import { lostReaders, writeSizedSeeds } from './scale-sweep-seed';
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
    expect(lostReaders(sent, loss, entities).get('listPosts')?.entity).toBe('sss_posts');
    expect(lostReaders(sent, loss, entities).get('thread')?.entity).toBe('sss_posts');
    expect(lostReaders(sent, loss, entities).get('archive')).toBeUndefined();
    expect(lostReaders(sent, loss, entities).get('listNotes')).toBeUndefined();
  });

  test('a column named like a lost table is no read of it: only a table position is', async () => {
    const loss = await writeSizedSeeds([graph()], entities, refusingPosts());
    const sent = new Map<string, SentStatement>([
      ['select "sss_posts" from "sss_notes"', { primitives: new Set(['column']) }],
      ['update "sss_notes" set "sss_posts" = 1', { primitives: new Set(['set']) }],
      ['select * from "sss_notes" n, "sss_posts" p', { primitives: new Set(['comma']) }],
    ]);
    expect(lostReaders(sent, loss, entities).get('column')).toBeUndefined();
    expect(lostReaders(sent, loss, entities).get('set')).toBeUndefined();
    expect(lostReaders(sent, loss, entities).get('comma')?.entity).toBe('sss_posts');
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
    expect(lostReaders(sent, loss, all).get('totals')?.entity).toBe('sss_posts');
    expect(lostReaders(sent, loss, all).get('rollup')?.entity).toBe('sss_posts');
    expect(lostReaders(sent, loss, all).get('audit')?.entity).toBe('sss_posts');
  });

  // Per subject, the lost set was re-derived — every entity described, each fixpoint round — and
  // every statement re-scanned: subjects × (entities + statements), 2.7 s of an adopter's sweep.
  // Once per sweep now: the descriptions do not grow with the subjects.
  test('the lost readers are found once per sweep, not once per subject', async () => {
    let described = 0;
    const counted = entities.map((one) =>
      Object.assign(Object.create(one) as typeof one, {
        $describe: () => {
          described += 1;
          return one.$describe();
        },
      }),
    );
    const loss = await writeSizedSeeds([graph()], entities, refusingPosts());
    const sent = new Map<string, SentStatement>(
      Array.from({ length: 300 }, (_, i) => [
        `select * from "sss_posts" where id = ${i}`,
        { primitives: new Set([`reader${i}`]) },
      ]),
    );
    const readers = lostReaders(sent, loss, counted);
    expect(readers.size).toBe(300);
    expect(readers.get('reader299')?.entity).toBe('sss_posts');
    expect(described).toBeLessThanOrEqual(counted.length * 4);
  });
});
