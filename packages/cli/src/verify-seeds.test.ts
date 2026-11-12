// The seed run on the `unit` step: no seed file is silence, a seed that writes is silence, and a
// seed whose row its entity refuses surfaces the ENTITY's own code and fix at the top level — the
// `{ minor: 19.99 }` that typechecks and was once found only by `e2e`, inside X_E2E_APP_FAILED.

import { afterAll, describe, expect, test } from 'bun:test';
// why: Bun has no mkdtemp and no recursive remove.
import { mkdtempSync, rmSync } from 'node:fs';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import type { ExecResult, Runner } from './exec';
import { exec } from './exec';
import { SEEDS_PROBE_MARKER, seedFindings } from './verify-seeds';

const SEED_FILE = 'packages/db/seeds/dev.ts';
const MIGRATION_FILE = 'packages/db/migrations/0001_init.sql';

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Inside this package, so the child resolves `@ultimat3/*` from its own `node_modules`. */
const appRoot = async (seed?: string, migration?: string): Promise<string> => {
  const dir = mkdtempSync(join(import.meta.dir, '..', '.seeds-fixture-'));
  dirs.push(dir);
  if (seed !== undefined) await Bun.write(join(dir, SEED_FILE), seed);
  if (migration !== undefined) await Bun.write(join(dir, MIGRATION_FILE), migration);
  return dir;
};

const MARKER = SEEDS_PROBE_MARKER;

/**
 * Every real child on ONE state directory, so the scratch database boots from the snapshot cache
 * the first one wrote — as an app's `.x/` does on every run after its first — not `initdb` each time.
 */
let state: string | undefined;
const child: Runner = (command, options) => {
  if (state === undefined) {
    state = mkdtempSync(join(import.meta.dir, '..', '.seeds-state-'));
    dirs.push(state);
  }
  return exec(command, { ...options, env: { ...options.env, ULTIMATE_STATE_DIR: state } });
};

const answering =
  (stdout: string, stderr = ''): Runner =>
  async (command): Promise<ExecResult> => ({
    command,
    code: 0,
    ok: true,
    stdout,
    stderr,
    durationMs: 1,
  });

/** The app's own schema: the seed run applies it, as every boot does, before any seed writes. */
const MIGRATION = `create table plans (
  id uuid primary key, code text not null, seats integer not null,
  monthly_minor bigint not null, monthly_currency char(3) not null, monthly_scale smallint
);
create table notes (body text not null);
`;

/**
 * A seed that reaches \`db()\` itself, as an adopter's \`register()\` from \`@ultimat3/auth\` does —
 * and reads its entity rows back through it, so both halves must land in ONE database.
 */
const DB_SEED = `import { defineAuth, postgresAuthAdapter, register } from '@ultimat3/auth';
import { db, sql } from '@ultimat3/db';
import { defineSeed, entity, integer, money, text, uuid } from '@ultimat3/entity';
const plans = entity('plan', {
  table: 'plans',
  columns: { id: uuid().primaryKey(), code: text(), seats: integer(), monthly: money() },
});
export const dev = defineSeed('dev', async ({ insert, id }) => {
  await insert(plans, [{ id: id('plan:team'), code: 'team', seats: 5, monthly: { minor: MINOR, currency: 'USD' } }]);
  await register(defineAuth({ adapter: postgresAuthAdapter() }), { email: 'ada@example.com', password: 'correct horse battery staple 42' });
  await db().execute(sql\`insert into notes (body) values (\${'seeded'})\`);
  const row = await db().one(sql\`select count(*)::int as n from plans\`);
  if (row?.n !== 1) throw new TypeError('the entity rows went to another store');
});
`;

const SEED = `import { defineSeed, entity, integer, money, text, uuid } from '@ultimat3/entity';
const plans = entity('plan', {
  table: 'plans',
  columns: { id: uuid().primaryKey(), code: text(), seats: integer(), monthly: money() },
});
export const dev = defineSeed('dev', async ({ insert, id }) => {
  await insert(plans, [{ id: id('plan:team'), code: 'team', seats: 5, monthly: { minor: MINOR, currency: 'USD' } }]);
});
`;

describe('unit · the seed run', () => {
  test('no seed file: nothing spawned, nothing said', async () => {
    let spawned = false;
    const runner: Runner = async (command) => {
      spawned = true;
      return answering('[]')(command, { cwd: '' });
    };
    expect(await seedFindings(await appRoot(), runner)).toEqual([]);
    expect(spawned).toBe(false);
  });

  test("a coded refusal surfaces with the inner error's own code and fix", async () => {
    const report = [
      {
        stage: 'run',
        file: SEED_FILE,
        export: 'dev',
        seed: 'dev',
        code: 'X_INVARIANT_VIOLATED',
        cause: 'got the float 19.99',
        fix: '{ minor: Math.round(amount * 100) }',
        message: 'X_INVARIANT_VIOLATED',
      },
    ];
    const [finding, ...rest] = await seedFindings(
      await appRoot('export {};\n'),
      answering(`noise\n${MARKER}${JSON.stringify(report)}\nafter\n`),
    );
    expect(rest).toEqual([]);
    expect(finding?.code).toBe('X_INVARIANT_VIOLATED');
    expect(finding?.cause).toContain('seed "dev"');
    expect(finding?.cause).toContain('got the float 19.99');
    expect(finding?.fix).toBe('{ minor: Math.round(amount * 100) }');
    expect(finding?.at).toBe(SEED_FILE);
  });

  test('an uncoded throw is still a finding, with a command that reproduces it', async () => {
    const report = [
      {
        stage: 'run',
        file: SEED_FILE,
        export: 'dev',
        seed: 'dev',
        code: null,
        cause: null,
        fix: null,
        message: 'boom',
      },
    ];
    const [finding] = await seedFindings(
      await appRoot('export {};\n'),
      answering(`${MARKER}${JSON.stringify(report)}`),
    );
    expect(finding?.code).toBe('X_SEED_FAILED');
    expect(finding?.cause).toContain('boom');
    expect(finding?.fix).toContain(SEED_FILE);
    expect(finding?.fix).toContain('.run()');
  });

  test('a child that prints no report is one finding with the reason, never a pass', async () => {
    const findings = await seedFindings(
      await appRoot('export {};\n'),
      answering('', 'SyntaxError: Unexpected token'),
    );
    expect(findings.length).toBe(1);
    expect(findings[0]?.cause).toContain('SyntaxError');
  });

  test(
    'a real child: integer money is green, a planted float is X_INVARIANT_VIOLATED',
    async () => {
      const app = (minor: string): Promise<string> =>
        appRoot(SEED.replace('MINOR', minor), MIGRATION);
      expect(await seedFindings(await app('1999'), child)).toEqual([]);
      const findings = await seedFindings(await app('19.99'), child);
      expect(findings.map((f) => f.code)).toEqual(['X_INVARIANT_VIOLATED']);
      expect(findings[0]?.cause).toContain('19.99');
      expect(findings[0]?.fix).toContain('Math.round');
      expect(findings[0]?.at).toBe(SEED_FILE);
      const throwing = SEED.replace('await insert(', "throw new TypeError('boom'); await insert(");
      const [uncoded] = await seedFindings(
        await appRoot(throwing.replace('MINOR', '1'), MIGRATION),
        child,
      );
      expect(uncoded?.code).toBe('X_SEED_FAILED');
      expect(uncoded?.cause).toContain('boom');
      expect(uncoded?.fix).toStartWith('bun --eval ');
    },
    { timeout: 60_000 },
  );

  test(
    'a real child: a seed that writes through db() runs on a migrated database, entity rows beside it',
    async () => {
      const green = await appRoot(DB_SEED.replace('MINOR', '1999'), MIGRATION);
      expect(await seedFindings(green, child)).toEqual([]);
      const float = await appRoot(DB_SEED.replace('MINOR', '19.99'), MIGRATION);
      const findings = await seedFindings(float, child);
      expect(findings.map((f) => f.code)).toEqual(['X_INVARIANT_VIOLATED']);
      expect(findings[0]?.fix).toContain('Math.round');
    },
    { timeout: 60_000 },
  );

  test(
    'a real child: an extension PGlite cannot link, with no server named, is a coded refusal',
    async () => {
      const app = await appRoot(
        DB_SEED.replace('MINOR', '1999'),
        `create extension if not exists postgis;\n${MIGRATION}`,
      );
      // Neither variable the fallback reads: the refusal must say which one to set.
      const unnamed: Runner = (command, options) =>
        exec(command, {
          ...options,
          env: { TEST_DATABASE_URL: undefined, DATABASE_URL: undefined },
        });
      const [finding, ...rest] = await seedFindings(app, unnamed);
      expect(rest).toEqual([]);
      expect(finding?.code).toBe('X_SCHEMA_DUMP_DRIFT');
      expect(finding?.cause).toContain("the seed run's scratch database (");
      expect(finding?.cause).toContain('did not open');
      expect(finding?.cause).toContain('"postgis"');
      expect(finding?.fix).toContain('TEST_DATABASE_URL=');
    },
    { timeout: 60_000 },
  );
});
