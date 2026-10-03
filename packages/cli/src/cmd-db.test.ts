// `x db` runs one migration engine, and this file is what says so. The gen path writes through
// `@ultimat3/db`, migrate and reset go through `serve.ts`'s `runMigrations` — the release phase's
// own function — and nothing anywhere shells out to a second migrator. Its post-condition is one
// check too: the live schema against the ledger, which is what `runMigrations` returns.

import { describe, expect, test } from 'bun:test';
// why: `node:fs`/`node:os` — Bun has no temp-directory API; `node:path` — no Bun path joiner.
import { mkdtempSync, rmSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';
import { ERROR_DOCS_URL } from '@ultimat3/core';
import { entity, uuid } from '@ultimat3/entity';
// Its own entry point, not the barrel: this helper is the one thing in `@ultimat3/testing` that
// value-imports `@ultimat3/entity`, and off the barrel it loaded the entity registry into every
// test that wanted the general harness.
import { isolateEntityRegistry } from '@ultimat3/testing/registry-isolation';
import { REQUIRED_BUN } from './app-root';
import { DB_SUBCOMMANDS, dbCommand, driftFindings } from './cmd-db';
import type { CommandContext } from './command';
import { SCHEMA_DUMP_DIR } from './db-schema-dump';
import { checkSourceDrift, schemaHash } from './drift';
import { exec } from './exec';
import { msg } from './messages';
import { MIGRATIONS_DIR } from './migrations';
import { renderJson } from './output';
import { flagBool, parseArgs } from './parse';
import { SPECS } from './registry';
import { thrownBy } from './thrown-by';

const ctxFor = (argv: readonly string[], cwd: string): CommandContext => ({
  args: parseArgs(argv, SPECS),
  cwd,
  runner: exec,
  env: {},
  bunVersion: REQUIRED_BUN,
});

/**
 * An app root the command will accept: `app.config.ts` is what `requireAppRoot` looks for.
 * `Bun.write` is a promise — unawaited, the command raced the file it needs and failed by timing.
 */
async function appRoot(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'x-db-cmd-'));
  await Bun.write(join(dir, 'app.config.ts'), 'export const config = {};\n');
  // One module the scan imports: an app whose scan imports NOTHING is `X_APP_EMPTY`, and these
  // cases passed only while some other file in the process had left a registry non-empty.
  await Bun.write(join(dir, 'apps/web/shared/app-name.ts'), "export const APP_NAME = 'db-cmd';\n");
  return dir;
}

/** `x db gen`'s `--json` body, parsed — the shape an agent reading this command actually gets. */
interface GenJson {
  readonly ok: boolean;
  readonly summary: string;
  readonly data: {
    readonly outcome: string;
    readonly migration: string | null;
    readonly files: readonly string[];
    readonly schemaHash: string | null;
    readonly schemaDump: {
      readonly directory: string;
      readonly status: string;
      readonly files: number;
      readonly written: readonly string[];
      readonly removed: readonly string[];
    };
  };
}

/**
 * `x db gen` replays the migrations on a scratch embedded database to write the schema dump — a
 * WASM compile plus an initdb, once per run that has a migration to replay. A hang detector, not a
 * budget.
 */
const DUMP_REPLAY_MS = 120_000;

const sidecar = (file: string): string => `${MIGRATIONS_DIR}/${file}`;

describe('unit · x db gen', () => {
  test('an unchanged schema generates nothing and still exits ok', async () => {
    // "Unchanged" means "no entity declares a table" — a premise this test used to inherit rather
    // than state, and `entity()` registers process-globally at module scope. `bun test
    // packages/jobs packages/cli` therefore generated a migration for `backfill_test_rows`, a
    // fixture two files away, and this failed for a reason nothing here named.
    const restoreEntities = isolateEntityRegistry();
    const root = await appRoot();
    try {
      const result = await dbCommand.run(ctxFor(['db', 'gen', 'nothing to do'], root));
      expect(result.ok).toBe(true);
      expect(result.data).toMatchObject({ migration: null });
    } finally {
      rmSync(root, { recursive: true, force: true });
      restoreEntities();
    }
  });

  // At the COMMAND altitude, through `renderJson`, because `--json` is the surface an agent reads
  // and the projection is where this went wrong: `runGen`'s no-migration branch hardcoded
  // `{ migration: null, files: [] }`, so a run that wrote the sidecar reported writing nothing.
  // Pinning `GeneratedFiles.outcome` alone would pin the data the projection reads, not the
  // projection — and the projection was the half that lied.
  test(
    '--json names the sidecar it wrote and calls it hash-recorded, never unchanged',
    async () => {
      const restoreEntities = isolateEntityRegistry();
      const root = await appRoot();
      try {
        entity('cmd_db_gen_json_notes', { columns: { id: uuid().primaryKey() } });
        await Bun.write(join(root, 'packages/db/src/schema.ts'), 'export const schema = 1;\n');

        const first = await dbCommand.run(ctxFor(['db', 'gen', 'add notes'], root));
        const written = JSON.parse(renderJson(first)) as GenJson;
        expect(written.data.outcome).toBe('generated');
        expect(written.data.migration).not.toBeNull();
        expect(written.data.files).toHaveLength(3);
        // The dump rides along: the new table's own file, and the framework's twin beside it.
        expect(written.data.schemaDump.status).toBe('written');
        expect(written.data.schemaDump.directory).toBe(SCHEMA_DUMP_DIR);
        expect(written.data.schemaDump.written).toContain(
          `${SCHEMA_DUMP_DIR}/04_tables/cmd_db_gen_json_notes.sql`,
        );
        expect(written.data.schemaDump.written).toContain(
          `${SCHEMA_DUMP_DIR}/framework/04_tables/x_migrations.sql`,
        );
        expect(written.data.schemaDump.files).toBe(written.data.schemaDump.written.length);

        // A seed is not DDL. The hash covers it anyway, so `drift` goes red with nothing to generate.
        await Bun.write(join(root, 'packages/db/src/seed.ts'), 'export const seed = () => {};\n');
        expect(await checkSourceDrift(root)).toHaveLength(1);
        // And a hand edit to the dump, which is what `X_SCHEMA_DUMP_DRIFT` reports: its `fix:` is
        // this same command, so the run below — with no DDL to generate — must put the bytes back.
        const table = join(root, SCHEMA_DUMP_DIR, '04_tables/cmd_db_gen_json_notes.sql');
        const original = await Bun.file(table).text();
        await Bun.write(table, original.replace('uuid', 'text'));

        const second = await dbCommand.run(ctxFor(['db', 'gen', 'describe the change'], root));
        const recorded = JSON.parse(renderJson(second)) as GenJson;
        expect(recorded.ok).toBe(true);
        expect(recorded.data.outcome).toBe('hash-recorded');
        expect(recorded.data.migration).toBeNull();
        // The claim the old body could not make: a file was written, and `--json` names which.
        expect(recorded.data.files).toEqual([`${written.data.migration}.hash`].map(sidecar));
        expect(recorded.data.schemaHash).toBe(await schemaHash(root));
        expect(recorded.summary).toBe(
          msg('cli.db.gen.recorded', { file: recorded.data.files[0] ?? '' }),
        );
        expect(recorded.summary).not.toBe(msg('cli.db.gen.unchanged'));
        // And the instruction `X_DB_DRIFT` hands out has actually been carried out.
        expect(await checkSourceDrift(root)).toEqual([]);
        // So has `X_SCHEMA_DUMP_DRIFT`'s: exactly the edited file was rewritten, to what it was.
        expect(recorded.data.schemaDump).toMatchObject({
          status: 'written',
          written: [`${SCHEMA_DUMP_DIR}/04_tables/cmd_db_gen_json_notes.sql`],
          removed: [],
        });
        expect(await Bun.file(table).text()).toBe(original);
      } finally {
        rmSync(root, { recursive: true, force: true });
        restoreEntities();
      }
    },
    DUMP_REPLAY_MS,
  );

  // Exit 1 with a migration on disk. An agent that reads only the exit code regenerates, and
  // gets a second migration for a schema the first already records.
  test('a dump that cannot be produced still reports the migration it wrote, and says not to repeat it', async () => {
    const restoreEntities = isolateEntityRegistry();
    const root = await appRoot();
    try {
      // An extension the embedded database cannot link, and no server named: the replay is
      // refused before any database boots, which is what keeps this test instant.
      await Bun.write(join(root, MIGRATIONS_DIR, '0000_geo.sql'), 'create extension postgis;\n');
      await Bun.write(join(root, MIGRATIONS_DIR, '0000_geo.snapshot.json'), '{"tables":[]}\n');
      entity('cmd_db_gen_dump_failed', { columns: { id: uuid().primaryKey() } });

      const result = await dbCommand.run(ctxFor(['db', 'gen', 'add things'], root));
      const body = JSON.parse(renderJson(result)) as GenJson;
      expect(body.ok).toBe(false);
      expect(body.data.outcome).toBe('generated');
      expect(body.data.schemaDump.status).toBe('failed');
      const id = body.data.migration ?? expect.unreachable('the migration was written');
      expect(await Bun.file(join(root, MIGRATIONS_DIR, `${id}.sql`)).exists()).toBe(true);
      expect(body.summary).toBe(msg('cli.db.gen.writtenDumpFailed', { id }));
      const [finding, ...rest] = result.findings ?? [];
      expect(rest).toEqual([]);
      expect(finding?.code).toBe('X_SCHEMA_DUMP_DRIFT');
      expect(finding?.cause).toStartWith(`migration ${id} WAS written to ${MIGRATIONS_DIR}`);
      expect(finding?.cause).toContain('extension "postgis"');
      expect(finding?.fix).toEndWith(
        ' x db gen   # a server with that extension installed, and a role that may create a database',
      );

      // And the instruction holds: the next bare run generates NO second migration.
      const again = await dbCommand.run(ctxFor(['db', 'gen'], root));
      expect(again.data).toMatchObject({ outcome: 'unchanged', migration: null });
      // Without a migration of its own to protect, the finding is the plain one.
      expect(again.findings?.[0]?.cause).not.toContain('WAS written');
    } finally {
      rmSync(root, { recursive: true, force: true });
      restoreEntities();
    }
  });

  // And a FOURTH that is none of them: the app did not load, so nothing was diffed at all. It
  // used to fall through to the `unchanged` sentence — "entities and migrations agree" — over an
  // exit 1, which told the reader the one thing this run could not know.
  test('a blocked run never reads as "nothing to generate"', async () => {
    const restoreEntities = isolateEntityRegistry();
    const root = await appRoot();
    try {
      await Bun.write(join(root, 'packages/db/src/broken.ts'), 'throw new Error("boom");\n');
      const result = await dbCommand.run(ctxFor(['db', 'gen', 'add notes'], root));
      const body = JSON.parse(renderJson(result)) as GenJson;
      expect(body.ok).toBe(false);
      expect(body.data.outcome).toBe('blocked');
      expect(body.summary).toBe(msg('cli.db.gen.blocked', { count: 1 }));
      expect(body.summary).not.toBe(msg('cli.db.gen.unchanged'));
      expect(result.findings?.length).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
      restoreEntities();
    }
  });

  // The third answer stays distinguishable from the second: nothing to generate AND nothing
  // written is not the same run as nothing to generate but a sidecar re-recorded.
  test('--json calls a run that wrote nothing at all unchanged, with an empty file list', async () => {
    const restoreEntities = isolateEntityRegistry();
    const root = await appRoot();
    try {
      const result = await dbCommand.run(ctxFor(['db', 'gen', 'nothing to do'], root));
      const body = JSON.parse(renderJson(result)) as GenJson;
      expect(body.data.outcome).toBe('unchanged');
      expect(body.data.files).toEqual([]);
      // No migration and no dump held: nothing is replayed, so this run boots no database.
      expect(body.data.schemaDump).toMatchObject({ status: 'skipped', files: 0, written: [] });
      expect(body.summary).toBe(msg('cli.db.gen.unchanged'));
    } finally {
      rmSync(root, { recursive: true, force: true });
      restoreEntities();
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

describe('unit · x db migrate', () => {
  // The whole command once, on a real embedded dev database: apply, verify against the ledger,
  // regenerate the dump from a scratch replay, then look at the dev database again for objects no
  // migration creates. Two embedded boots, so one test carries every assertion about them.
  test(
    'applies, writes the schema dump, and reports nothing on a database only migrations touched',
    async () => {
      const root = await appRoot();
      try {
        const id = '0001_notes';
        await Bun.write(
          join(root, MIGRATIONS_DIR, `${id}.sql`),
          // `citext` on purpose: PGlite links an extension only when it is named at boot, so
          // this migration applies on the DEV database only if `x dev`'s boot and the dump's
          // scratch replay ask the same linker. The gate used to pass where `x dev` failed.
          'create extension citext;\ncreate table "notes" ("id" uuid primary key, "email" citext);\n' +
            '-- down\ndrop table "notes";\ndrop extension citext;\n',
        );
        await Bun.write(
          join(root, MIGRATIONS_DIR, `${id}.snapshot.json`),
          JSON.stringify({
            tables: [
              {
                schema: 'public',
                name: 'notes',
                columns: [
                  { name: 'id', dataType: 'uuid', nullable: false, default: null, position: 1 },
                  { name: 'email', dataType: 'citext', nullable: true, default: null, position: 2 },
                ],
                primaryKey: ['id'],
                indexes: [],
                foreignKeys: [],
              },
            ],
          }),
        );

        const result = await dbCommand.run(ctxFor(['db', 'migrate'], root));
        expect(result.findings ?? []).toEqual([]);
        expect(result.ok).toBe(true);
        expect(result.data).toMatchObject({
          applied: [id],
          schemaDump: { directory: SCHEMA_DUMP_DIR, status: 'written', removed: [] },
        });
        // What it wrote is on disk, and it is the table the migration created.
        const table = Bun.file(join(root, SCHEMA_DUMP_DIR, '04_tables/notes.sql'));
        expect(await table.text()).toContain('"email" citext');
        expect(result.lines).toContain(`  ${SCHEMA_DUMP_DIR}/01_extensions/citext.sql`);
        // Human render and `--json` agree: one line per file written.
        expect(result.lines).toContain(`  ${SCHEMA_DUMP_DIR}/04_tables/notes.sql`);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    DUMP_REPLAY_MS,
  );
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
        docs: ERROR_DOCS_URL,
      },
      {
        code: 'X_DB_DRIFT',
        cause: 'table "comments" is declared by migrations but does not exist',
        fix: 'x db migrate',
        docs: ERROR_DOCS_URL,
      },
    ]);
  });

  test('a clean database reports nothing, so x db migrate exits 0', () => {
    expect(driftFindings({ ok: true, differences: [] })).toEqual([]);
  });
});

/**
 * A flag `x db` declares is a flag ONE of its seven subcommands reads, and the summary has said
 * which since the flag was added. Saying it is not enforcing it: `x db gen --dry-run` parsed,
 * reached `runGen`, and wrote the migration — the caller asked for a dry run and got a file.
 */
describe('unit · x db flags belong to the subcommand that reads them', () => {
  test('--dry-run on gen is refused, and the fix names the subcommand that honours it', () => {
    const failure = thrownBy(() => parseArgs(['db', 'gen', 'add publish_at', '--dry-run'], SPECS));
    expect(failure.code).toBe('X_CLI_BAD_FLAG');
    expect(failure.cause).toBe(
      '--dry-run on "x db gen": read by x db seed only — "gen" would ignore it',
    );
    expect(failure.fix).toBe('x db seed --dry-run');
    // And the shapes that DO read their flags still parse, unchanged.
    expect(flagBool(parseArgs(['db', 'seed', '--dry-run'], SPECS), 'dry-run')).toBe(true);
    expect(flagBool(parseArgs(['db', 'backfill', '--pending'], SPECS), 'pending')).toBe(true);
    expect(
      flagBool(parseArgs(['db', 'gen', 'x', '--allow-destructive'], SPECS), 'allow-destructive'),
    ).toBe(true);
  });

  // The mechanical half is `parse.test.ts`'s, over every shipped command: a summary is prose and
  // drifts silently, `subcommands` is read by the parser, and the rule that keeps them one fact
  // has to hold for `x jobs` and `x pr` too or it is a rule about one file.
});

describe('unit · x db seed never answers ok beside a failure', () => {
  // The seed file that would not import may be the very seed asked for, so "no seed to run" over
  // it is a vacuous green — the shape `seedPassResult` already refuses one branch over.
  test('a seed module that will not import fails the run, even with nothing left to seed', async () => {
    const root = await appRoot();
    try {
      await Bun.write(
        join(root, 'packages/db/seeds/01_orgs.ts'),
        "import './nobody-wrote-this';\n",
      );
      const result = await dbCommand.run(ctxFor(['db', 'seed'], root));
      expect(result.ok).toBe(false);
      expect(result.findings?.map((finding) => finding.at)).toEqual([
        'packages/db/seeds/01_orgs.ts',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
