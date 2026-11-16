// `x db status` at the command altitude, on the embedded database: a never-created one is read as
// "no ledger, nothing applied" without being initialised, a migrated one is current, and one
// migration past the ledger is the boot's own refusal. The verdict's cases are `db-status.test.ts`'s.

import { afterEach, describe, expect, test } from 'bun:test';
// why: `node:fs` — Bun has no temp-directory API and no directory probe.
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { migrate, pgliteClient, pgliteDataDir, setDbClient } from '@ultimat3/db';
import { REQUIRED_BUN } from './app-root';
import { DB_SUBCOMMANDS, dbCommand } from './cmd-db';
import type { CommandContext } from './command';
import { exec } from './exec';
import { citedCommandProblem, loadCommandCatalog } from './fix-command';
import { applyLockedSchema } from './framework-schema-apply';
import { MIGRATIONS_DIR, readMigrations } from './migrations';
import { renderJson } from './output';
import { parseArgs } from './parse';
import { SPECS } from './registry';
import { resolveServices } from './runtime-bindings';

const ctxFor = (argv: readonly string[], cwd: string): CommandContext => ({
  args: parseArgs(argv, SPECS),
  cwd,
  runner: exec,
  env: {},
  bunVersion: REQUIRED_BUN,
});

const dirs: string[] = [];
afterEach(() => {
  setDbClient(undefined);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** An app root with two migrations on disk; its `.x/` is where the embedded database lives. */
async function appRoot(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'x-db-status-'));
  dirs.push(dir);
  await Bun.write(join(dir, 'app.config.ts'), "export const config = { name: 'fixture' };\n");
  for (const [id, table] of [
    ['20260101000000_a', 'a'],
    ['20260102000000_b', 'b'],
  ] as const) {
    await Bun.write(
      join(dir, MIGRATIONS_DIR, `${id}.sql`),
      `-- up\ncreate table "${table}" ("id" text primary key);\n-- down\ndrop table "${table}";\n`,
    );
  }
  return dir;
}

interface Body {
  readonly ok: boolean;
  readonly findings: readonly { readonly code: string; readonly fix: string }[];
  readonly data: {
    readonly applied: readonly string[] | null;
    readonly pending: readonly string[];
    readonly ahead: readonly string[];
    readonly framework: { readonly applied: boolean };
  };
}

const status = async (root: string): Promise<Body> =>
  JSON.parse(renderJson(await dbCommand.run(ctxFor(['db', 'status', '--json'], root)))) as Body;

/** A WASM compile plus an initdb — a hang detector, not a budget. */
const PGLITE_BOOT_MS = 120_000;

describe('unit · x db status', () => {
  test('is a declared subcommand, and a fix citing it resolves', async () => {
    expect(DB_SUBCOMMANDS).toContain('status');
    expect(citedCommandProblem('x db status --json', await loadCommandCatalog())).toBeUndefined();
  });

  test('a database never created: no ledger, every migration pending, nothing initialised', async () => {
    const root = await appRoot();
    const body = await status(root);
    expect(body.ok).toBe(false);
    expect(body.data.applied).toBeNull();
    expect(body.data.pending).toEqual(['20260101000000_a', '20260102000000_b']);
    expect(body.data.framework.applied).toBe(false);
    expect(body.findings.map((finding) => finding.code)).toEqual([
      'X_FRAMEWORK_SCHEMA_UNAPPLIED',
      'X_APP_MIGRATIONS_UNAPPLIED',
    ]);
    expect(existsSync(pgliteDataDir(resolveServices(root, {}).db.url))).toBe(false);
  });

  test(
    'migrated, then one migration past the ledger: current, then pending with the boot fix',
    async () => {
      const root = await appRoot();
      const migrations = await readMigrations(root);
      const dataDir = pgliteDataDir(resolveServices(root, {}).db.url);
      const client = pgliteClient({ dataDir });
      try {
        await applyLockedSchema(client);
        await migrate({ client, migrations: migrations.slice(0, 1), lock: false });
      } finally {
        await client.close();
      }
      const behind = await status(root);
      expect(behind.data.applied).toEqual(['20260101000000_a']);
      expect(behind.data.pending).toEqual(['20260102000000_b']);
      expect(behind.data.framework.applied).toBe(true);
      expect(behind.findings.map((finding) => [finding.code, finding.fix])).toEqual([
        ['X_APP_MIGRATIONS_UNAPPLIED', 'x db migrate'],
      ]);

      const again = pgliteClient({ dataDir });
      try {
        await migrate({ client: again, migrations, lock: false });
      } finally {
        await again.close();
      }
      const current = await status(root);
      expect(current).toMatchObject({ ok: true, findings: [] });
      expect(current.data.pending).toEqual([]);
      expect(current.data.ahead).toEqual([]);
    },
    PGLITE_BOOT_MS,
  );
});
