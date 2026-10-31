// The two readings `concurrent-index.ts` makes of migration text: whether the file declares it runs
// outside a transaction, and which statement is a concurrent index build — and of WHAT name, since
// that name is what the runner looks up for an INVALID leftover before building it again.

import { describe, expect, test } from 'bun:test';
import {
  concurrentIndexTarget,
  firstConcurrentStatement,
  isConcurrentIndexStatement,
  isNonTransactional,
  NO_TRANSACTION_MARKER,
} from './concurrent-index';

describe('unit · the `-- transaction: false` marker', () => {
  test('a top-level line of its own declares it, in any case and with CRLF', () => {
    expect(isNonTransactional(`${NO_TRANSACTION_MARKER}\ncreate index …;`)).toBe(true);
    expect(isNonTransactional('-- 2026_x\n--Transaction:  FALSE\r\nselect 1;')).toBe(true);
  });

  test('a mention, a block comment and a dollar body declare nothing', () => {
    // Each of these is prose ABOUT the marker, and running a migration outside its transaction on
    // the strength of one would apply half a file with no ledger row when it failed.
    expect(isNonTransactional('-- transaction: false is needed for concurrent builds')).toBe(false);
    expect(isNonTransactional('/*\n-- transaction: false\n*/ select 1;')).toBe(false);
    expect(isNonTransactional('do $$ begin\n-- transaction: false\nend $$;')).toBe(false);
    expect(isNonTransactional('select 1; -- transaction: false')).toBe(false);
    expect(isNonTransactional('create index "x" on "t" ("a");')).toBe(false);
  });
});

describe('unit · the index a concurrent build names', () => {
  test('the name as the statement spells it — quoted, bare or schema-qualified', () => {
    expect(
      concurrentIndexTarget(
        'create index concurrently if not exists "runs_status_idx" on "runs" ("status")',
      ),
    ).toBe('"runs_status_idx"');
    expect(concurrentIndexTarget('CREATE UNIQUE INDEX CONCURRENTLY runs_key ON runs (id)')).toBe(
      'runs_key',
    );
    expect(concurrentIndexTarget('create index concurrently public."Runs_Idx" on runs (a)')).toBe(
      'public."Runs_Idx"',
    );
    // A leading comment is noise, never a token.
    expect(concurrentIndexTarget('-- why\ncreate index /* c */ concurrently "a""b" on t (x)')).toBe(
      '"a""b"',
    );
  });

  test('null for a plain build, an unnamed one, a drop and a name that is only a word', () => {
    expect(concurrentIndexTarget('create index "x" on "t" ("a")')).toBeNull();
    // Postgres picks the name of an unnamed build, so there is nothing to look up.
    expect(concurrentIndexTarget('create index concurrently on t (a)')).toBeNull();
    expect(concurrentIndexTarget('drop index concurrently if exists "x"')).toBeNull();
    // A quoted "create" is a name, not the verb.
    expect(concurrentIndexTarget('"create" index concurrently x on t (a)')).toBeNull();
  });
});

describe('unit · statements Postgres refuses inside a transaction block', () => {
  test('the three concurrent index forms are recognised', () => {
    expect(isConcurrentIndexStatement('create index concurrently "x" on "t" ("a")')).toBe(true);
    expect(isConcurrentIndexStatement('create unique index concurrently x on t (a)')).toBe(true);
    expect(isConcurrentIndexStatement('drop index concurrently if exists "x"')).toBe(true);
    expect(isConcurrentIndexStatement('reindex (verbose) index concurrently "x"')).toBe(true);
  });

  test('REINDEX: past any option list, and CONCURRENTLY as an option too', () => {
    // The option list can be long enough to push the modifier past any fixed token window.
    expect(
      isConcurrentIndexStatement(
        'REINDEX (VERBOSE true, TABLESPACE pg_default) INDEX CONCURRENTLY "runs_status_idx"',
      ),
    ).toBe(true);
    expect(isConcurrentIndexStatement('reindex (concurrently) table runs')).toBe(true);
    expect(isConcurrentIndexStatement('reindex (verbose, concurrently true) index x')).toBe(true);
    expect(isConcurrentIndexStatement('reindex (concurrently false) index x')).toBe(false);
    expect(isConcurrentIndexStatement('reindex (concurrently off, verbose) table runs')).toBe(
      false,
    );
    expect(isConcurrentIndexStatement('reindex index "concurrently"')).toBe(false);
    expect(isConcurrentIndexStatement('reindex table runs')).toBe(false);
  });

  test('a plain build, a plain drop and a string mentioning the word are not', () => {
    expect(isConcurrentIndexStatement('create index "x" on "t" ("a")')).toBe(false);
    expect(isConcurrentIndexStatement('drop index if exists "x"')).toBe(false);
    expect(isConcurrentIndexStatement("insert into notes values ('drop index concurrently')")).toBe(
      false,
    );
    expect(isConcurrentIndexStatement('refresh materialized view concurrently mv')).toBe(false);
  });

  test('firstConcurrentStatement finds the one statement in a script that needs the marker', () => {
    const script =
      'alter table "t" add column "a" text;\ncreate index concurrently "x" on "t" ("a");';
    expect(firstConcurrentStatement(script)).toBe('create index concurrently "x" on "t" ("a")');
    expect(firstConcurrentStatement('create index "x" on "t" ("a");')).toBeUndefined();
  });
});
