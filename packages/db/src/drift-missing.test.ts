// The degraded half of each repair `drift-missing.ts` writes: a name the shell screen refuses is
// left out of the command, never escaped into it, and a declaration no writer can spell is a psql
// session and a sentence — never a throw out of `diffSchema`, which is pure and total.

import { describe, expect, test } from 'bun:test';
import {
  changedIndex,
  missingColumn,
  missingForeignKey,
  missingIndex,
  missingTable,
} from './drift-missing';
import type { ColumnDescription, IndexDescription } from './introspect';

// `identifier()` accepts a backtick and `$`; only the shell screen refuses them.
const HOSTILE = 'posts`pwned`$HOME';

const column = (name: string, over: Partial<ColumnDescription> = {}): ColumnDescription => ({
  name,
  dataType: 'text',
  nullable: true,
  default: null,
  position: 1,
  ...over,
});

const index = (over: Partial<IndexDescription> = {}): IndexDescription => ({
  name: 'posts_title_idx',
  columns: ['title'],
  unique: false,
  primary: false,
  where: null,
  order: null,
  ...over,
});

const BY_HAND = 'psql "$DATABASE_URL"   # ';

describe('a repair no statement can spell', () => {
  test('a hostile table name reaches no command, in any of the five', () => {
    const fixes = [
      missingColumn('public', HOSTILE, column('title')).fix,
      missingTable('public', HOSTILE, [column('id')], ['id']).fix,
      missingIndex('public', HOSTILE, index()).fix,
      changedIndex('public', HOSTILE, index(), index(), 'covers (id)').fix,
      missingForeignKey('public', HOSTILE, {
        name: 'posts_org_id_fkey',
        columns: ['org_id'],
        referencedTable: 'orgs',
        referencedColumns: ['id'],
        onDelete: null,
      }).fix,
    ];
    for (const fix of fixes) {
      expect(fix).toStartWith(BY_HAND);
      expect(fix).not.toContain('pwned');
    }
  });

  test('a declaration the writer refuses is a session, not a throw', () => {
    // `createIndex` refuses an index naming no column (`X_INVARIANT`).
    expect(missingIndex('public', 'posts', index({ columns: [] })).fix).toStartWith(BY_HAND);
  });

  test('a schema off public is set on the same psql word', () => {
    expect(missingIndex('tenant_a', 'posts', index()).fix).toStartWith(
      `psql "$DATABASE_URL" -c 'set search_path = "tenant_a"; create index`,
    );
  });

  test('a NOT NULL column nothing fills is added nullable, and the note says what comes next', () => {
    const fix = missingColumn('public', 'posts', column('title', { nullable: false })).fix;
    expect(fix).toContain(`add column "title" text;'`);
    expect(fix).toContain('names the set not null');
    const filled = missingColumn(
      'public',
      'posts',
      column('status', { nullable: false, default: "'draft'::text" }),
    ).fix;
    expect(filled).toContain(`add column "status" text default '\\''draft'\\''::text not null;'`);
  });

  test('a unique index a constraint may own drops the constraint first', () => {
    const unique = index({ unique: true });
    expect(changedIndex('public', 'posts', unique, unique, 'is unique').fix).toContain(
      `alter table "posts" drop constraint if exists "posts_title_idx"; drop index if exists`,
    );
    expect(changedIndex('public', 'posts', index(), index(), 'covers (id)').fix).not.toContain(
      'drop constraint',
    );
  });
});

describe('a missing column with a declared collation', () => {
  test('the repair re-adds it with the collation the snapshot recorded', () => {
    expect(missingColumn('public', 'people', column('name', { collation: 'C' })).fix).toContain(
      'add column "name" text collate "C"',
    );
  });
});
