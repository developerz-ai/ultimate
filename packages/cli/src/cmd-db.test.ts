// `x db` runs one migration engine, and this file is what says so. The gen path writes through
// `@ultimat3/db`, migrate and reset go through `serve.ts`'s `runMigrations` — the release phase's
// own function — and nothing anywhere shells out to a second migrator. Its post-condition is one
// check too: the live schema against the ledger, which is what `runMigrations` returns.

import { afterEach, describe, expect, test } from 'bun:test';
// `node:fs`/`node:os` — Bun has no temp-directory API; `node:path` — no Bun path joiner.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { entity, memoryRepo, tableFor, uuid } from '@ultimat3/entity';
import type { JobDriver } from '@ultimat3/jobs';
import { backfill, createMemoryDriver, resetJobDriver, setJobDriver } from '@ultimat3/jobs';
import { branchDatabaseName, branchSql, DB_SUBCOMMANDS, dbCommand, driftFindings } from './cmd-db';
import type { CommandContext } from './command';
import { BadFlagError } from './errors';
import { exec } from './exec';
import { msg } from './messages';
import type { CommandResult } from './output';
import { flagBool, parseArgs } from './parse';
import { SPECS } from './registry';

const ctxFor = (argv: readonly string[], cwd: string): CommandContext => ({
  args: parseArgs(argv, SPECS),
  cwd,
  runner: exec,
  env: {},
  bunVersion: '1.3.0',
});

/**
 * An app root the command will accept: `app.config.ts` is what `requireAppRoot` looks for.
 * `Bun.write` is a promise — unawaited, the command raced the file it needs and failed by timing.
 */
async function appRoot(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'x-db-cmd-'));
  await Bun.write(join(dir, 'app.config.ts'), 'export const config = {};\n');
  return dir;
}

describe('unit · x db gen', () => {
  test('an unchanged schema generates nothing and still exits ok', async () => {
    const root = await appRoot();
    try {
      const result = await dbCommand.run(ctxFor(['db', 'gen', 'nothing to do'], root));
      expect(result.ok).toBe(true);
      expect(result.data).toMatchObject({ migration: null });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('--allow-destructive parses, because X_MIGRATION_IRREVERSIBLE tells you to run it', () => {
    const args = parseArgs(['db', 'gen', 'drop it', '--allow-destructive'], SPECS);
    expect(flagBool(args, 'allow-destructive')).toBe(true);
  });
});

describe('unit · x db studio is planned, not a second engine', () => {
  test('it exits X_NOT_IMPLEMENTED with a fix that runs today', async () => {
    const root = await appRoot();
    try {
      const failure: unknown = await dbCommand.run(ctxFor(['db', 'studio'], root)).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure).toBeUltimateError('X_NOT_IMPLEMENTED');
      expect((failure as { fix: string }).fix).toContain('x dev');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('it stays in the subcommand list, so the parser reaches it', () => {
    expect(DB_SUBCOMMANDS).toContain('studio');
  });
});

describe('unit · x db reset', () => {
  test('refuses an external Postgres rather than dropping a database it does not own', async () => {
    const root = await appRoot();
    try {
      const ctx = { ...ctxFor(['db', 'reset'], root), env: { DATABASE_URL: 'postgres://x/y' } };
      const failure: unknown = await dbCommand.run(ctx).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure).toBeUltimateError('X_NOT_IMPLEMENTED');
      expect((failure as { fix: string }).fix).toContain('x db migrate');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('unit · x db branch', () => {
  test('a branch name is sanitised into the database it clones into', () => {
    expect(branchDatabaseName('postly', 'feat/new-thing')).toBe('postly_branch_feat_new_thing');
    expect(branchSql('postly', 'postly_branch_x')).toBe(
      'CREATE DATABASE "postly_branch_x" TEMPLATE "postly"',
    );
  });
});

describe('unit · one engine, everywhere', () => {
  test('no shipped source spawns a second migrator', async () => {
    const offenders: string[] = [];
    for await (const file of new Bun.Glob('packages/*/src/**/*.ts').scan({
      cwd: join(import.meta.dir, '..', '..', '..'),
      absolute: true,
    })) {
      if (file.includes('.test.')) continue;
      // The argv form, not the word: this file and `cmd-db.ts` both name drizzle-kit in prose to
      // say it is gone, and a gate that cannot tell prose from a spawn would forbid saying so.
      if ((await Bun.file(file).text()).includes("'drizzle-kit'")) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  test("migrate and reset route through the release phase's own function", async () => {
    const source = await Bun.file(join(import.meta.dir, 'cmd-db.ts')).text();
    // Structural, because the alternative is a second migrator nobody notices: the moment this
    // file stops importing `runMigrations`, `x db migrate` and `ROLE=migrate` are two engines again.
    expect(source).toContain("import { runMigrations } from './serve'");
  });

  test('the post-migrate check is the database one, and it is asked where the connection is', async () => {
    const here = await Bun.file(join(import.meta.dir, 'cmd-db.ts')).text();
    const serve = await Bun.file(join(import.meta.dir, 'serve.ts')).text();
    // `checkSourceDrift` reads files and answers the same before and after a migration, so a
    // migrate that reported it was verifying nothing about the database it had just written.
    expect(here).not.toContain("from './drift'");
    expect(serve).toContain('checkDrift');
    expect(here).toContain('migrated.drift');
  });
});

describe('unit · the post-migrate report renders the pinned contract output', () => {
  test('every difference becomes one X_DB_DRIFT finding with its own runnable fix', () => {
    const findings = driftFindings({
      ok: false,
      differences: [
        {
          kind: 'unexpected-column',
          table: 'posts',
          column: 'hotfix',
          cause: 'table "posts" has column "hotfix" not present in any migration',
          fix: 'x db gen "add hotfix"',
        },
        {
          kind: 'missing-table',
          table: 'comments',
          column: null,
          cause: 'table "comments" is declared by migrations but does not exist',
          fix: 'x db migrate',
        },
      ],
    });
    expect(findings).toEqual([
      {
        code: 'X_DB_DRIFT',
        cause: 'table "posts" has column "hotfix" not present in any migration',
        fix: 'x db gen "add hotfix"',
        docs: 'https://ultimate.dev/errors/X_DB_DRIFT',
      },
      {
        code: 'X_DB_DRIFT',
        cause: 'table "comments" is declared by migrations but does not exist',
        fix: 'x db migrate',
        docs: 'https://ultimate.dev/errors/X_DB_DRIFT',
      },
    ]);
  });

  test('a clean database reports nothing, so x db migrate exits 0', () => {
    expect(driftFindings({ ok: true, differences: [] })).toEqual([]);
  });
});

/** Install the driver `withJobDriver` must reuse, so no test here boots a queue or a database. */
async function runBackfill(driver: JobDriver, argv: readonly string[]): Promise<CommandResult> {
  setJobDriver(driver);
  const root = await appRoot();
  try {
    return await dbCommand.run(ctxFor(argv, root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

interface SweepRow {
  readonly id: string;
  readonly orgId: string;
}

/**
 * `entity()` registers globally, so it is built inside `source` — a body no test here calls.
 * Registered at module scope it would make `x db gen`'s "an unchanged schema generates nothing"
 * emit a migration for a table only this file knows about.
 */
const declareSweep = (name: string) =>
  backfill<SweepRow>({
    name,
    source: () => {
      const rows = entity(`cmd_db_${name.replaceAll('-', '_')}`, {
        columns: { id: uuid().primaryKey(), orgId: uuid() },
      });
      return tableFor(rows, memoryRepo(rows, []));
    },
    handle: () => undefined,
  });

/** One name's row out of `x db backfill`'s `--json`, whatever else the process declared. */
const planFor = (result: CommandResult, name: string): { readonly action: string } | undefined =>
  (result.data as readonly { readonly name: string; readonly action: string }[]).find(
    (row) => row.name === name,
  );

const queuedCount = async (driver: JobDriver): Promise<number> =>
  (await driver.stats()).reduce((total, stats) => total + stats.ready + stats.delayed, 0);

async function seedPass(driver: JobDriver, runId: string, name: string): Promise<void> {
  await driver.backfills?.start({ runId, name, checksum: 'abc123', appVersion: '1.2.0' });
  await driver.backfills?.progress(runId, { rows: 250, cursor: 'post_250' });
}

afterEach(() => {
  resetJobDriver();
});

describe('unit · x db backfill', () => {
  test('every flag the four shapes need is declared, so the parser reaches them', () => {
    expect(DB_SUBCOMMANDS).toContain('backfill');
    const flags = dbCommand.spec.flags?.map((flag) => flag.name) ?? [];
    for (const flag of ['list', 'status', 'limit', 'pending', 'all', 'write', 'force']) {
      expect(flags).toContain(flag);
    }
    // `--name` already meant "migration or branch"; one declaration, widened, never a second.
    expect(flags.filter((flag) => flag === 'name')).toHaveLength(1);
  });

  test('a bare x db backfill refuses and names a shape that works', async () => {
    const driver = createMemoryDriver();
    const thrown: unknown = await runBackfill(driver, ['db', 'backfill']).then(
      () => undefined,
      (error: unknown) => error,
    );
    // Not X_NOT_IMPLEMENTED: this subcommand ships four shapes. Not a silent default to one of
    // them either — they answer four different questions, and picking one is the ambiguity axiom
    // 1 refuses.
    expect(thrown).toBeInstanceOf(BadFlagError);
    expect((thrown as BadFlagError).fix).toBe('x db backfill --pending --json');
    expect((thrown as BadFlagError).cause).toContain('--pending');
  });

  test('--pending names a declared sweep the ledger has never recorded, and exits non-zero', async () => {
    // Declared in the test body, never at module scope: the jobs registry is process-wide and
    // this file shares it with every other suite in the run.
    declareSweep('cmd-db-never-run');
    const result = await runBackfill(createMemoryDriver(), ['db', 'backfill', '--pending']);

    // The exit code is the whole point: a cron reads it without parsing the table.
    expect(result.ok).toBe(false);
    expect(result.findings?.map((finding) => finding.code)).toContain('X_BACKFILL_PENDING');
    expect(result.data).toMatchObject({ environment: 'development' });
    expect((result.data as { pending: readonly string[] }).pending).toContain('cmd-db-never-run');
    expect(result.summary).not.toContain('⟦');
  });

  test('a name no declaration carries is X_BACKFILL_UNKNOWN, and writes nothing', async () => {
    const result = await runBackfill(createMemoryDriver(), ['db', 'backfill', 'never-declared']);
    expect(result.ok).toBe(false);
    expect(result.findings?.[0]?.code).toBe('X_BACKFILL_UNKNOWN');
    expect(result.findings?.[0]?.fix).toContain('x db backfill --pending');
    expect(result.data).toMatchObject([{ name: 'never-declared', action: 'blocked', jobId: null }]);
  });

  test('a dry run plans and writes nothing; --all --write enqueues the pending sweep', async () => {
    declareSweep('cmd-db-all-sweep');
    const driver = createMemoryDriver();

    const dry = await runBackfill(driver, ['db', 'backfill', '--all']);
    expect(planFor(dry, 'cmd-db-all-sweep')?.action).toBe('planned');
    expect(dry.summary).not.toContain('⟦');
    expect(await queuedCount(driver)).toBe(0);

    const written = await runBackfill(driver, ['db', 'backfill', '--all', '--write']);
    expect(planFor(written, 'cmd-db-all-sweep')?.action).toBe('enqueued');
    expect(await queuedCount(driver)).toBeGreaterThan(0);
  });

  test('--list prints the ledger as a table and carries the same rows in data', async () => {
    const driver = createMemoryDriver();
    await seedPass(driver, 'run_1', 'reindex-posts');

    const result = await runBackfill(driver, ['db', 'backfill', '--list']);
    const rendered = (result.lines ?? []).join('\n');

    expect(result.ok).toBe(true);
    expect(result.summary).toBe(msg('cli.db.backfill.listed', { count: 1 }));
    expect(rendered).toContain('started-at');
    expect(rendered).toContain('reindex-posts');
    expect(rendered).toContain('post_250');
    expect(rendered).not.toContain('⟦');
    expect(result.data).toMatchObject([
      { runId: 'run_1', name: 'reindex-posts', status: 'running', rows: 250, cursor: 'post_250' },
    ]);
  });

  test('an empty ledger is ok: nothing has swept this database yet is an answer', async () => {
    const result = await runBackfill(createMemoryDriver(), ['db', 'backfill', '--list']);

    expect(result.ok).toBe(true);
    expect(result.summary).toBe(msg('cli.db.backfill.empty'));
    expect(result.lines).toEqual([]);
    expect(result.data).toEqual([]);
  });

  test('--name and --status filter the ledger the command prints', async () => {
    const driver = createMemoryDriver();
    await seedPass(driver, 'run_1', 'reindex-posts');
    await seedPass(driver, 'run_2', 'recount-likes');

    const named = await runBackfill(driver, [
      'db',
      'backfill',
      '--list',
      '--name',
      'recount-likes',
    ]);
    expect(named.data).toMatchObject([{ runId: 'run_2' }]);

    const done = await runBackfill(driver, ['db', 'backfill', '--list', '--status', 'completed']);
    expect(done.data).toEqual([]);
  });
});
