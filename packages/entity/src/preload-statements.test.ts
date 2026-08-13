// What `preload()` costs on the wire: one extra statement per relation, over the distinct keys the
// page carried, carrying the scope the page was read under. Counted against the recording client,
// because "one statement" is a claim about SQL and only SQL can answer it.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { createRecordingClient, type RecordingClient, setDbClient } from '@ultimat3/db';
import { text, timestamp, uuid } from './columns';
import { database } from './database';
import { entity } from './entity';
import { postgresDriver } from './pg-driver';
import { clearRegistry } from './registry';

const orgs = entity('preload_stmt_orgs', {
  columns: { id: uuid().primaryKey(), slug: text({ max: 40 }) },
});

const members = entity('preload_stmt_members', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid()
      .references(() => orgs.id)
      .tenant(),
    email: text({ max: 120 }),
    deletedAt: timestamp().nullable(),
  },
});

const posts = entity('preload_stmt_posts', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid()
      .references(() => orgs.id)
      .tenant(),
    authorId: uuid().references(() => members.id),
    reviewerId: uuid()
      .references(() => members.id)
      .nullable(),
    title: text({ max: 120 }),
  },
});

const idAt = (index: number): string =>
  `00000000-0000-7000-8000-${String(index).padStart(12, '0')}`;

const ORG = idAt(1);
const ANA = idAt(10);
const BEN = idAt(11);

/** What Bun.SQL hands back: snake_case names, nothing decoded. */
const postRow = (index: number, authorId: string, reviewerId: string | null = null) => ({
  id: idAt(index),
  org_id: ORG,
  author_id: authorId,
  reviewer_id: reviewerId,
  title: `Post ${index}`,
});

const memberRow = (id: string) => ({
  id,
  org_id: ORG,
  email: `${id}@example.com`,
  deleted_at: null,
});

let client: RecordingClient;

beforeEach(() => {
  client = createRecordingClient();
  setDbClient(client);
  // Three posts, two authors: what the preload binds is the distinct set, not the page.
  client.on('preload_stmt_posts', {
    rows: [postRow(20, ANA), postRow(21, ANA, BEN), postRow(22, BEN)],
  });
  client.on('preload_stmt_members', { rows: [memberRow(ANA), memberRow(BEN)] });
});

afterAll(() => {
  setDbClient(undefined);
  clearRegistry();
});

const db = () => database({ orgs, members, posts }, { driver: postgresDriver() });

const preloadStatement = (): string => client.texts[1] ?? '';

describe('what a preload costs', () => {
  test('a page and its relation are two statements, whatever the page holds', async () => {
    const rows = await db().posts.where({ orgId: ORG }).preload('author').all();

    expect(rows).toHaveLength(3);
    expect(client.texts).toHaveLength(2);
    expect(preloadStatement()).toContain('from "preload_stmt_members"');
  });

  test('the keys are the distinct ones the page carried — three rows, two binds', async () => {
    await db().posts.where({ orgId: ORG }).preload('author').all();

    expect(preloadStatement()).toContain('"id" in ($1, $2)');
    expect(client.statements[1]?.values.slice(0, 2)).toEqual([ANA, BEN]);
  });

  test('two relations are one statement each', async () => {
    await db().posts.where({ orgId: ORG }).preload('author').preload('reviewer').all();

    expect(client.texts).toHaveLength(3);
  });

  test('naming one relation twice is one statement — a chain is not a queue', async () => {
    await db().posts.where({ orgId: ORG }).preload('author').preload('author').all();

    expect(client.texts).toHaveLength(2);
  });

  test('a page with no key to resolve sends no second statement', async () => {
    client.on('preload_stmt_posts', { rows: [] });

    expect(await db().posts.where({ orgId: ORG }).preload('author').all()).toEqual([]);
    expect(client.texts).toHaveLength(1);
  });
});

describe('what the preload statement carries', () => {
  test('the tenant predicate the page was read under is inside the SQL Postgres runs', async () => {
    await db().posts.where({ orgId: ORG }).preload('author').all();

    expect(preloadStatement()).toContain('"org_id" =');
    expect(client.statements[1]?.values).toContain(ORG);
  });

  test('the soft-delete clause is the one any other read of that entity carries', async () => {
    await db().posts.where({ orgId: ORG }).preload('author').all();

    expect(preloadStatement()).toContain('"deleted_at" is null');
  });

  test('a projection cannot drop the key the preload reads', async () => {
    await db()
      .posts.where({ orgId: ORG })
      .select({ id: true, title: true })
      .preload('author')
      .all();

    // The caller named two columns; the statement asks for the third because the framework does.
    expect(client.texts[0]).toContain('"author_id"');
  });

  test('a hasMany reads the other side by its own foreign key', async () => {
    await db().members.where({ orgId: ORG }).preload('preload_stmt_postsByAuthor').all();

    expect(preloadStatement()).toContain('from "preload_stmt_posts"');
    expect(preloadStatement()).toContain('"author_id" in');
  });

  test('count() reads no row, so it attaches nothing and sends nothing extra', async () => {
    client.on('count(', { rows: [{ count: '3' }] });

    expect(await db().posts.where({ orgId: ORG }).preload('author').count()).toBe(3);
    expect(client.texts).toHaveLength(1);
  });
});
