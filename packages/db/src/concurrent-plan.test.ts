// The deferred step's script order and what the transactional step's snapshot may claim while that
// step is still pending. A snapshot claiming a key the catalog lacks is a key the next `x db gen`
// never re-emits, so the first file records the world before the swap.

import { describe, expect, test } from 'bun:test';
import {
  buildConcurrently,
  contractKey,
  deferKey,
  deferValidate,
  emptyConcurrentPlan,
  intermediateSnapshot,
  stepStatements,
} from './concurrent-plan';
import { snapshotOf } from './generate';
import type { ForeignKeyDescription } from './introspect';
import { tableOf, uuidColumn } from './rolling-fixture';

const oldKey: ForeignKeyDescription = {
  name: 'comments_post_id_fkey',
  columns: ['post_id'],
  referencedTable: 'posts',
  referencedColumns: ['id'],
  onDelete: null,
};
const newKey: ForeignKeyDescription = {
  name: 'comments_post_id_tenant_fkey',
  columns: ['org_id', 'post_id'],
  referencedTable: 'posts',
  referencedColumns: ['org_id', 'id'],
  onDelete: null,
};
const INDEX = {
  name: 'posts_org_id_id_key',
  columns: ['org_id', 'id'],
  unique: true,
  where: null,
  order: null,
} as const;

const swap = () => {
  const plan = emptyConcurrentPlan();
  buildConcurrently('posts', INDEX, plan);
  deferKey('comments', newKey, undefined, plan);
  contractKey('comments', oldKey, plan);
  return plan;
};

describe('stepStatements', () => {
  test('up: index builds, key adds, validates, then the contract', () => {
    const plan = swap();
    deferValidate('comments', 'comments_body_check', plan);
    expect(stepStatements(plan).up).toEqual([
      'create unique index concurrently if not exists "posts_org_id_id_key" on "posts" ("org_id", "id");',
      'alter table "comments" drop constraint if exists "comments_post_id_tenant_fkey", add constraint "comments_post_id_tenant_fkey" foreign key ("org_id", "post_id") references "posts" ("org_id", "id") not valid;',
      'alter table "comments" validate constraint "comments_post_id_tenant_fkey";',
      'alter table "comments" validate constraint "comments_body_check";',
      'alter table "comments" drop constraint if exists "comments_post_id_fkey";',
    ]);
  });

  test('down: restore the old key, drop the new key, drop the index', () => {
    expect(stepStatements(swap()).down).toEqual([
      'alter table "comments" drop constraint if exists "comments_post_id_fkey", add constraint "comments_post_id_fkey" foreign key ("post_id") references "posts" ("id") not valid;',
      'alter table "comments" validate constraint "comments_post_id_fkey";',
      'alter table "comments" drop constraint if exists "comments_post_id_tenant_fkey";',
      'drop index concurrently if exists "posts_org_id_id_key";',
    ]);
  });

  test('a contract key goes before a removed index: the key may be what needs the index', () => {
    const plan = swap();
    plan.contract.push('drop index concurrently if exists "old";');
    const { up } = stepStatements(plan);
    expect(up.at(-2)).toContain('drop constraint if exists "comments_post_id_fkey"');
    expect(up.at(-1)).toBe('drop index concurrently if exists "old";');
  });
});

describe('intermediateSnapshot', () => {
  const final = snapshotOf([
    tableOf('comments', [uuidColumn('org_id'), uuidColumn('post_id', { references: 'posts.id' })]),
    tableOf('posts'),
  ]);

  test('lacks the new key and keeps the one it replaces', () => {
    const table = final.tables.find((each) => each.name === 'comments');
    const wanted = {
      ...final,
      tables: final.tables.map((each) =>
        each === table ? { ...each, foreignKeys: [newKey] } : each,
      ),
    };
    const plan = swap();
    const first = intermediateSnapshot(wanted, plan.deferred, plan.deferredKeys);
    const comments = first.tables.find((each) => each.name === 'comments');
    expect(comments?.foreignKeys).toEqual([oldKey]);
  });

  test('a same-named rebuild reads as the recorded rule', () => {
    const plan = emptyConcurrentPlan();
    const moved = { ...oldKey, onDelete: 'cascade' };
    deferKey('comments', moved, oldKey, plan);
    const wanted = {
      tables: final.tables.map((each) =>
        each.name === 'comments' ? { ...each, foreignKeys: [moved] } : each,
      ),
    };
    const comments = intermediateSnapshot(wanted, plan.deferred, plan.deferredKeys).tables.find(
      (each) => each.name === 'comments',
    );
    expect(comments?.foreignKeys).toEqual([oldKey]);
  });
});
