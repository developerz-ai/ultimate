// A generated `fix:` is copied and run verbatim, so a scaffold that names a command this build
// does not ship is a dead end in every app ever created from it. `x g backfill` shipped one —
// `x jobs enqueue`, which JOBS_SUBCOMMANDS has never contained — and this file is what keeps the
// generator honest about the surface it points at.

import { describe, expect, test } from 'bun:test';
import { DB_SUBCOMMANDS } from '../cmd-db';
import { JOBS_SUBCOMMANDS } from '../cmd-jobs';
import { backfillFiles } from './backfill';

const target = { feature: 'post', surfaceDir: 'app' } as const;

const generated = (name = 'normalize-titles'): { source: string; test: string } => {
  const files = backfillFiles(name, target);
  return { source: files[0]?.contents ?? '', test: files[1]?.contents ?? '' };
};

describe('unit · x g backfill', () => {
  test('writes the declaration and its test, under the feature own backfills directory', () => {
    const files = backfillFiles('normalize-titles', target);
    expect(files.map((file) => file.path)).toEqual([
      'app/post/backfills/normalize-titles.ts',
      'app/post/backfills/normalize-titles.test.ts',
    ]);
  });

  test('every command a generated fix line names is one this build actually ships', () => {
    const source = generated().source;
    // The regression: `x jobs enqueue` is not a subcommand and never was.
    expect(source).not.toContain('x jobs enqueue');
    expect(JOBS_SUBCOMMANDS).not.toContain('enqueue');
    expect(source).toContain('x db backfill normalize-titles --write --json');
    expect(DB_SUBCOMMANDS).toContain('backfill');
  });

  test('the tenancy assert still carries a cause and a runnable fix, not just a message', () => {
    const source = generated().source;
    expect(source).toContain('carries no orgId');
    expect(source).toContain('--json');
  });

  test('count(), requires and environments are offered as declarations, not as defaults', () => {
    const source = generated().source;
    // Commented out on purpose: this scaffold re-normalises every row in the org, so a count of
    // the same chain never reaches zero and every generated app would trip X_BACKFILL_STALLED.
    expect(source).toContain('// count: ({ ctx })');
    expect(source).toContain('// requires:');
    expect(source).toContain('// environments:');
    expect(source).toContain('X_BACKFILL_STALLED');
  });

  test('the generated source declares no environments, so a scaffold runs everywhere', () => {
    // "cleanups are production" is a business convention and the framework never ships one.
    const source = generated().source;
    expect(source).not.toMatch(/^\s*environments:/m);
  });

  test('neither generated file carries a TODO — a generator emits working source', () => {
    // The rule this package states and nothing checked: a generated `// TODO` is blocking. The
    // commented-out `count`/`requires`/`environments` above are OFFERS with a stated reason, which
    // is a different thing from a hole an author is expected to notice and fill.
    const files = backfillFiles('normalize-titles', target);
    for (const file of files) {
      expect(file.contents).not.toMatch(/\bTODO\b/);
      expect(file.contents).not.toMatch(/\bFIXME\b/);
      // A stub that throws carries no `X_*` code and reports rows nobody swept.
      expect(file.contents).not.toContain('throw new Error(');
    }
  });

  test('the generated test still pins the work, not only the declaration around it', () => {
    const suite = generated().test;
    expect(suite).toContain('actually rewrites the row it is handed');
    expect(suite).toContain('idempotent');
  });
});
