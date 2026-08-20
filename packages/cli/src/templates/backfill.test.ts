// A generated `fix:` is copied and run verbatim, so a scaffold that names a command this build
// does not ship is a dead end in every app ever created from it. `x g backfill` shipped one —
// `x jobs enqueue`, which JOBS_SUBCOMMANDS has never contained — and this file is what keeps the
// generator honest about the surface it points at.

import { describe, expect, test } from 'bun:test';
import { DB_SUBCOMMANDS } from '../cmd-db';
import { JOBS_SUBCOMMANDS } from '../cmd-jobs';
import { backfillFiles } from './backfill';

const target = { feature: 'post', surfaceDir: 'app' } as const;

/**
 * Selected by path, never by index: the generator also emits the slice modules its source imports
 * (`../entity`), and a positional read would silently start asserting about `entity.ts`.
 */
const generated = (name = 'normalize-titles'): { source: string; test: string } => {
  const files = backfillFiles(name, target);
  const at = (path: string): string => {
    const found = files.find((file) => file.path === path)?.contents;
    return typeof found === 'string' ? found : '';
  };
  return {
    source: at(`app/post/backfills/${name}.ts`),
    // `.job.test.ts`: a sweep is a job, so the gate's `job` step is the one that must select it.
    test: at(`app/post/backfills/${name}.job.test.ts`),
  };
};

describe('unit · x g backfill', () => {
  test('writes the declaration and its test, under the feature own backfills directory', () => {
    const files = backfillFiles('normalize-titles', target);
    // The slice's own modules come first and are `if-absent`; the backfill's two are the run's.
    expect(files.filter((file) => file.merge === undefined).map((file) => file.path)).toEqual([
      'app/post/backfills/normalize-titles.ts',
      'app/post/backfills/normalize-titles.job.test.ts',
    ]);
    // `../entity` is what the declaration reads and what the generated test builds rows of, so the
    // generator writes it too — the run that emitted the import is the run that has to close it.
    expect(files.map((file) => file.path)).toContain('app/post/entity.ts');
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
    expect(source).toContain('holds no tenancy:cross');
    expect(source).toContain('--json');
  });

  test('the sweep declares its tenant, and declares the one a sweep actually has', () => {
    const source = generated().source;
    // `tenant` is required by `BackfillDefinition`, and a scaffold that omitted it would fail at
    // import with X_JOB_TENANT_REQUIRED rather than at typecheck — so this pins the declaration.
    expect(source).toContain("tenant: 'none',");
    // `'none'` strips the org, so the emitted scope must NOT be the one that reads it back off the
    // actor: that assert could only ever fire. Both halves have to move together or the scaffold
    // ships source guaranteed to throw on its first run.
    expect(source).not.toContain('ctx.actor;');
    // The EXECUTABLE half of the pairing, not the sentence about it: the pass mints `tenancy:cross`
    // on its own actor for a `tenant: 'none'` backfill, and this guard is the scaffold's only
    // reader of that fact. A source that dropped the import or the check would still contain every
    // word of the comment above it.
    expect(source).toContain('import { CROSS_TENANT_SCOPE, postgresRepo, tableFor } from');
    expect(source).toContain('hasScope(ctx.actor, CROSS_TENANT_SCOPE)');
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

  test('a backfill named after its own feature does not redeclare the entity it imports', () => {
    // `x g backfill post --feature post` is a legal invocation and it emitted `import { post }`
    // beside `export const post = backfill(...)`: one name, two declarations, which is
    // lint/suspicious/noRedeclare in the app's own gate and an ambiguous reference in TS.
    const source = backfillFiles('post', target).find(
      (file) => file.path === 'app/post/backfills/post.ts',
    )?.contents;
    expect(source).toContain("import { post as postEntity } from '../entity';");
    expect(source).toContain('export const post = backfill({');
    expect(source).toContain('tableFor(postEntity, postgresRepo(postEntity))');
  });

  test('a backfill named anything else imports the entity plainly — the alias is not the default', () => {
    const source = generated().source;
    expect(source).toContain("import { post } from '../entity';");
    expect(source).not.toContain('postEntity');
  });

  test('the generated test still pins the work, not only the declaration around it', () => {
    const suite = generated().test;
    expect(suite).toContain('actually rewrites the row it is handed');
    expect(suite).toContain('idempotent');
  });
});
