// A fix is run, not read. `fix-command.ts` proves a fix names a real command, across every code; this
// proves, for the codes below, that running it helps: each row breaks a scaffolded app, asserts the
// code, EXECUTES the printed line through a shell, and requires the failure gone or a stated next
// refusal. Exit 0 with the original failure still there is the bug this exists for.
//
// A false fix found later adds a row, in the diff that repairs it. Opt-in by design: most fixes need a
// database, a deploy or a secret, so this is a table of the ones that do not.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
// why: Bun ships no path joiner.
import { join } from 'node:path';
import { auditLedger, checksumOf, type LedgerRow } from '@ultimat3/db';
import { emptyCatalog } from '@ultimat3/db/schema-dump';
import { readSchemaDump, SCHEMA_DUMP_DIR } from './db-schema-dump';
import { exec } from './exec';
import { type FixtureApp, fixtureApp, GIT } from './fix-truth-fixture';
import { MIGRATIONS_DIR, readMigrations } from './migrations';
import type { Finding } from './output';
import { checkSchemaDump } from './schema-dump-drift';
import { VERIFY_STEPS } from './verify-checks';
import type { VerifyStepName } from './verify-step';

let app: FixtureApp;

// A real scaffold, real biome, real child `x` processes.
const ROW_MS = 60_000;

beforeAll(async () => {
  app = await fixtureApp();
}, ROW_MS);

afterAll(() => app.remove());

interface Report {
  readonly steps?: readonly { readonly findings: readonly Finding[] }[];
  readonly findings?: readonly Finding[];
}

/** Every finding a `--json` command reported, wherever it put them. */
const findingsOf = (stdout: string): readonly Finding[] => {
  const report = JSON.parse(stdout) as Report;
  return [...(report.findings ?? []), ...(report.steps ?? []).flatMap((step) => step.findings)];
};

/** One gate step in process: the row is about what it reports, and a child `x` is seconds per call. */
const verifyStep = async (name: VerifyStepName): Promise<readonly Finding[]> => {
  const step = VERIFY_STEPS.find((one) => one.name === name);
  if (step === undefined) return expect.unreachable(`no step ${name}`);
  const outcome = await step.run({ root: app.root, runner: exec, env: {} } as never);
  return outcome.findings;
};

/** What the app load reports, in a child: the registries and the resolver are per process. */
const loadFindings = async (): Promise<readonly Finding[]> => {
  const loader = join(import.meta.dir, 'app-load.ts');
  await Bun.write(
    join(app.root, '.shims/load.ts'),
    `import { setLogStream } from '@ultimat3/core';
import { loadApp } from ${JSON.stringify(loader)};
setLogStream('stderr');
process.stdout.write(JSON.stringify((await loadApp(process.cwd())).findings));`,
  );
  const { stdout, stderr } = await app.sh('bun .shims/load.ts');
  if (stdout === '') return expect.unreachable(`the load crashed: ${stderr}`);
  return JSON.parse(stdout) as readonly Finding[];
};

const write = (path: string, contents: string): Promise<number> =>
  Bun.write(join(app.root, path), contents);

const POST = 'apps/web/app/post';

interface Row {
  readonly name: string;
  readonly code: string;
  /** Applies the break, and returns the finding that says so. */
  readonly refuse: () => Promise<Finding | undefined>;
  /** What running the printed line must leave true. */
  readonly holds: (fix: string) => Promise<void>;
  /** A fix that names an edit: the edit, made as the line says. Absent: the line is executed. */
  readonly perform?: (fix: string) => Promise<void>;
}

const ROWS: readonly Row[] = [
  {
    name: 'D1b a format miss is told --write on the file',
    code: 'X_LINT_FAILED',
    refuse: async () => {
      await write(`${POST}/truth.ts`, 'export const used   =   2\n');
      return (await verifyStep('lint'))[0];
    },
    holds: async () => {
      expect(await verifyStep('lint')).toEqual([]);
    },
  },
  {
    name: 'D1b an unused variable is an edit naming the line, never --write',
    code: 'X_LINT_FAILED',
    refuse: async () => {
      await write(`${POST}/truth.ts`, 'const unused = 1;\nexport const used = 2;\n');
      return (await verifyStep('lint')).find((one) => one.at === `${POST}/truth.ts`);
    },
    perform: async (fix) => {
      expect(fix).not.toContain('--write');
      expect(fix).toContain(`edit ${POST}/truth.ts:1`);
      await write(`${POST}/truth.ts`, 'export const used = 2;\n');
    },
    holds: async () => {
      expect(await verifyStep('lint')).toEqual([]);
    },
  },
  {
    name: 'D3 a typoed --feature writes into the slice it meant',
    code: 'X_FEATURE_UNKNOWN',
    refuse: async () =>
      findingsOf((await app.sh('x g action shipPost --feature pst --json')).stdout)[0],
    holds: async () => {
      expect(await Bun.file(join(app.root, `${POST}/actions/ship-post.ts`)).exists()).toBe(true);
      expect(await Bun.file(join(app.root, 'apps/web/app/pst/entity.ts')).exists()).toBe(false);
    },
  },
  {
    name: 'D4 a route reading a repo gets a query in that slice, and no table',
    code: 'X_BOUNDARY_ROUTE_TO_DB',
    refuse: async () => {
      await write(
        'apps/web/app/shoplist/page.tsx',
        "import { list } from '../post/repo';\nexport const Page = () => String(list);\n",
      );
      const found = await verifyStep('boundaries');
      return found.find((one) => one.code === 'X_BOUNDARY_ROUTE_TO_DB');
    },
    holds: async () => {
      expect(await Bun.file(join(app.root, `${POST}/queries/shoplist.ts`)).exists()).toBe(true);
      const { stdout } = await app.sh('git status --short --untracked-files=all');
      expect(stdout).not.toContain('shoplist/entity.ts');
      expect(stdout).not.toContain('shoplists');
    },
  },
  {
    name: 'D6 a relative import that resolves to nothing names the file, and the edit clears it',
    code: 'X_APP_IMPORT_UNRESOLVED',
    refuse: async () => {
      await write(`${POST}/truth.ts`, "export { x } from '../nowhere/repo';\n");
      return (await loadFindings()).find((one) => one.code === 'X_APP_IMPORT_UNRESOLVED');
    },
    perform: async (fix) => {
      const shown = await app.sh(fix);
      expect(shown.stdout).toContain('../nowhere/repo');
      await write(`${POST}/truth.ts`, 'export const x = 1;\n');
    },
    holds: async () => {
      expect(await loadFindings()).toEqual([]);
    },
  },
  {
    name: 'D12a a $view key naming no column is an edit, with the columns on its line',
    code: 'X_INVARIANT_VIOLATED',
    refuse: async () => {
      await write(
        `${POST}/truth.ts`,
        "import { post } from './entity';\nexport const v = (post.$view as (k: string[]) => unknown)(['titel']);\n",
      );
      return (await loadFindings()).find((one) => one.code === 'X_INVARIANT_VIOLATED');
    },
    perform: async (fix) => {
      expect(fix).not.toContain('x entities show');
      const pick = /pick from: (\w+)/.exec(fix)?.[1];
      await write(
        `${POST}/truth.ts`,
        `import { post } from './entity';\nexport const v = (post.$view as (k: string[]) => unknown)(['${String(pick)}']);\n`,
      );
    },
    holds: async () => {
      expect(await loadFindings()).toEqual([]);
    },
  },
];

describe('a printed fix, executed', () => {
  test.each(ROWS.map((row) => [row.name, row] as const))(
    '%s',
    async (_name, row) => {
      try {
        const finding = await row.refuse();
        expect(finding?.code).toBe(row.code);
        const fix = finding?.fix ?? '';
        if (row.perform === undefined) {
          const ran = await app.sh(fix);
          expect({ fix, code: ran.code, stderr: ran.stderr }).toEqual({
            fix,
            code: 0,
            stderr: expect.any(String),
          });
        } else {
          await row.perform(fix);
        }
        await row.holds(fix);
      } finally {
        await app.reset();
      }
    },
    ROW_MS,
  );
});

/** A migration, its snapshot and the dump it produced, as `x db gen` leaves them, committed. */
const COLUMN_DUMP = (columns: readonly string[]): string =>
  [
    'create table "truth" (',
    ...columns.map((name) => `  "${name}" text,`),
    '  constraint "c" PRIMARY KEY (id)',
    ');',
    '',
  ].join('\n');

describe('D2 · an applied migration, edited', () => {
  const ID = '0001_truth';
  const SQL = `${MIGRATIONS_DIR}/${ID}.sql`;
  const PRISTINE = 'create table truth (id text);\n';

  beforeAll(async () => {
    await write(SQL, PRISTINE);
    await write(
      `${MIGRATIONS_DIR}/${ID}.snapshot.json`,
      JSON.stringify({
        tables: [
          {
            schema: 'public',
            name: 'truth',
            columns: [{ name: 'id', dataType: 'text', nullable: true, default: null, position: 1 }],
            primaryKey: [],
            indexes: [],
            foreignKeys: [],
          },
        ],
      }),
    );
    await write(`${SCHEMA_DUMP_DIR}/04_tables/truth.sql`, COLUMN_DUMP(['id']));
    await app.sh(
      'git add -A && git -c user.name=t -c user.email=t@example.com commit -qm migrated',
    );
  }, ROW_MS);

  afterAll(async () => {
    await app.reset();
  });

  /** The replay is the dump itself: this row is about the snapshot rail, and a boot is seconds. */
  const drift = async (): Promise<readonly Finding[]> => {
    const files = await readSchemaDump(app.root);
    return checkSchemaDump(app.root, {}, async () => ({
      catalog: emptyCatalog(),
      files,
      reload: [],
    }));
  };

  const ledgerAudit = async (row: LedgerRow): Promise<string | undefined> => {
    try {
      auditLedger([row], await readMigrations(app.root), 'dev');
      return undefined;
    } catch (error) {
      return (error as { fix: string }).fix;
    }
  };

  test(
    'X_MIGRATION_CONFLICT restores the file, and the ledger agrees again',
    async () => {
      const row = {
        id: ID,
        name: 'truth',
        checksum: checksumOf(PRISTINE),
        app_version: 'dev',
      } as LedgerRow;
      const clean = (await readMigrations(app.root))[0];
      const applied = { ...row, checksum: checksumOf(clean?.up ?? '') };
      expect(await ledgerAudit(applied)).toBeUndefined();
      // Committed, which is what `git checkout -- <file>` could not undo: HEAD is the edit.
      await write(SQL, 'create table truth (id text, hacked text);\n');
      await app.sh(`${GIT} commit -qam edit`);
      const fix = (await ledgerAudit(applied)) ?? '';
      const listed = await app.sh(fix);
      expect(listed.code).toBe(0);
      // As the line says: each listed revision, until the ledger's checksum agrees.
      const restore = /git checkout <rev> -- (\S+)/.exec(fix)?.[1] ?? '';
      let agreed = false;
      for (const rev of listed.stdout.split('\n').map((line) => line.split(' ')[0] ?? '')) {
        if (rev === '' || agreed) continue;
        await app.sh(`git checkout -q ${rev} -- ${restore}`);
        agreed = (await ledgerAudit(applied)) === undefined;
      }
      expect(agreed).toBe(true);
    },
    ROW_MS,
  );

  test(
    'the poisoned dump is red at drift until restored, and the printed line restores it',
    async () => {
      // What `x db gen "fix initial"` did, exit 0: the edit is in the migration AND in the dump.
      await write(SQL, 'create table truth (id text, hacked text);\n');
      await write(`${SCHEMA_DUMP_DIR}/04_tables/truth.sql`, COLUMN_DUMP(['id', 'hacked']));
      const [finding] = await drift();
      expect(finding?.code).toBe('X_DB_DRIFT');
      expect(finding?.cause).toContain('"hacked"');
      expect((await app.sh(finding?.fix ?? '')).code).toBe(0);
      expect(await drift()).toEqual([]);
    },
    ROW_MS,
  );
});
