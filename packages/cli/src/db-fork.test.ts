// The whole forked-chain path at command altitude: two branches' migrations on one disk, the
// refusal from every reader, its printed fix followed as printed, then a real replay and `drift`.

import { afterAll, describe, expect, test } from 'bun:test';
// why: `node:fs`/`node:os` — Bun has no temp-directory API; `node:path` — no Bun path joiner.
import { mkdtempSync, readdirSync, renameSync, rmSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';
import { clearRegistry, entity, uuid } from '@ultimat3/entity';
import { isolateEntityRegistry } from '@ultimat3/testing/registry-isolation';
import { REQUIRED_BUN } from './app-root';
import { dbCommand } from './cmd-db';
import type { CommandContext } from './command';
import { exec } from './exec';
import { withCheckoutLock } from './heavy';
import { HEAVY_DIR_ENV } from './heavy-env';
import { msg } from './messages';
import { MIGRATIONS_DIR, readMigrations } from './migrations';
import { flagBool, parseArgs } from './parse';
import { SPECS } from './registry';
import { checkMigrationDrift } from './schema-drift';
import { checkSchemaDump } from './schema-dump-drift';

/** Each `x db gen` here replays the chain on a scratch embedded database. A hang detector. */
const REPLAY_MS = 180_000;

const ctxFor = (
  argv: readonly string[],
  cwd: string,
  env: CommandContext['env'] = {},
): CommandContext => ({
  args: parseArgs(argv, SPECS),
  cwd,
  runner: exec,
  env,
  bunVersion: REQUIRED_BUN,
});

async function appRoot(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'x-db-fork-'));
  await Bun.write(join(dir, 'app.config.ts'), "export const config = { name: 'fixture' };\n");
  await Bun.write(join(dir, 'apps/web/shared/app-name.ts'), "export const APP_NAME = 'fork';\n");
  await Bun.write(join(dir, 'packages/db/src/schema.ts'), 'export const schema = 1;\n');
  return dir;
}

// A skipped suite still evaluates this module: the reset runs at file scope either way.
afterAll(() => {
  clearRegistry();
});

const declare = (...tables: readonly string[]): void => {
  clearRegistry();
  for (const table of tables) entity(table, { columns: { id: uuid().primaryKey() } });
};

const generate = async (root: string, name: string, stamp: string): Promise<void> => {
  const result = await dbCommand.run(ctxFor(['db', 'gen', name], root));
  expect(result.findings ?? []).toEqual([]);
  const id = (result.data as { readonly migration: string }).migration;
  const dir = join(root, MIGRATIONS_DIR);
  for (const suffix of ['.sql', '.snapshot.json', '.hash']) {
    renameSync(join(dir, `${id}${suffix}`), join(dir, `${stamp}${suffix}`));
  }
};

/** Everything under the migrations directory, as bytes: "nothing moved" is this being equal. */
async function filesOf(root: string): Promise<Readonly<Record<string, string>>> {
  const dir = join(root, MIGRATIONS_DIR);
  const entries = await Promise.all(
    readdirSync(dir)
      .sort()
      .map(async (name) => [name, await Bun.file(join(dir, name)).text()] as const),
  );
  return Object.fromEntries(entries);
}

/** One parent, then each branch generated from it alone: what `git merge` leaves on disk. */
async function mergedBranches(root: string): Promise<void> {
  declare('fork_base');
  await generate(root, 'initial', '20260101000001_initial');
  const parent = await filesOf(root);
  declare('fork_base', 'fork_alphas');
  await generate(root, 'create alphas', '20260101000002_create_alphas');
  const left = await filesOf(root);
  for (const name of Object.keys(left)) {
    if (!(name in parent)) rmSync(join(root, MIGRATIONS_DIR, name));
  }
  declare('fork_base', 'fork_betas');
  await generate(root, 'create betas', '20260101000003_create_betas');
  for (const [name, text] of Object.entries(left)) {
    await Bun.write(join(root, MIGRATIONS_DIR, name), text);
  }
  declare('fork_alphas', 'fork_base', 'fork_betas');
}

describe('a forked migration chain', () => {
  test(
    'is refused everywhere, its fix works as printed, and replay and drift end green',
    async () => {
      const restore = isolateEntityRegistry();
      const root = await appRoot();
      try {
        await mergedBranches(root);
        const before = await filesOf(root);

        const [finding, ...others] = await checkMigrationDrift(root);
        expect(others).toEqual([]);
        expect(finding?.code).toBe('X_MIGRATION_FORKED');
        expect(finding?.cause).toContain('table "fork_alphas"');
        const fix = finding?.fix ?? expect.unreachable('the refusal carries a fix');
        expect(fix).not.toContain("'record");
        expect(fix).not.toMatch(/\brm\b/);
        expect(
          await checkSchemaDump(root, {}, async () =>
            expect.unreachable('a forked chain answers once, with no replay behind it'),
          ),
        ).toEqual([]);

        for (const argv of [
          ['db', 'gen', 'record fork_alphas'],
          ['db', 'migrate'],
        ]) {
          const refused = await dbCommand.run(ctxFor(argv, root));
          expect(refused.ok).toBe(false);
          expect(refused.findings?.map((entry) => entry.code)).toEqual(['X_MIGRATION_FORKED']);
        }
        expect(await filesOf(root)).toEqual(before);

        const command = fix.split('#')[0]?.trim() ?? '';
        const argv = command.split(/\s+/).slice(1);
        expect(argv).toEqual(['db', 'gen', '--merge-fork']);
        const merged = await dbCommand.run(ctxFor(argv, root));
        expect(merged.findings ?? []).toEqual([]);
        expect(merged.ok).toBe(true);
        const id = '20260101000003_create_betas';
        expect(merged.data).toMatchObject({ outcome: 'fork-merged', migration: null, newest: id });
        expect(merged.summary).toBe(msg('cli.db.gen.forkMerged', { count: 1, id }));
        // The dump is what a replay of the chain produces, so `written` is the replay succeeding.
        expect((merged.data as { schemaDump: { status: string } }).schemaDump.status).toBe(
          'written',
        );

        const after = await filesOf(root);
        expect(Object.keys(after)).toEqual(Object.keys(before));
        for (const name of Object.keys(before).filter((file) => file.endsWith('.sql'))) {
          expect(after[name]).toBe(before[name] ?? '');
        }
        expect(await checkMigrationDrift(root)).toEqual([]);
        const again = await dbCommand.run(ctxFor(['db', 'gen'], root));
        expect(again.data).toMatchObject({ outcome: 'unchanged', migration: null, newest: id });
        expect(again.lines).toContain(msg('cli.db.gen.newest', { id }));
        expect(await readMigrations(root)).toHaveLength(3);
      } finally {
        rmSync(root, { recursive: true, force: true });
        restore();
      }
    },
    REPLAY_MS,
  );

  test('--merge-fork parses for gen and is refused elsewhere', () => {
    expect(flagBool(parseArgs(['db', 'gen', '--merge-fork'], SPECS), 'merge-fork')).toBe(true);
    expect(() => parseArgs(['db', 'migrate', '--merge-fork'], SPECS)).toThrow();
  });
});

/** Reads `stream` until `wanted` appears, or to its end: a run that never waits has ended by then. */
async function sawLine(stream: ReadableStream<Uint8Array>, wanted: string): Promise<boolean> {
  const decoder = new TextDecoder();
  let text = '';
  for await (const chunk of stream) {
    text += decoder.decode(chunk, { stream: true });
    if (text.includes(wanted)) return true;
  }
  return false;
}

/** A second process, because the lock is per descriptor and the race it closes is between CLIs. */
const genInChild = (root: string, env: Readonly<Record<string, string>>) =>
  Bun.spawn(
    [
      process.execPath,
      '-e',
      `import { entity, uuid } from '@ultimat3/entity';
       import { dbCommand } from ${JSON.stringify(join(import.meta.dir, 'cmd-db.ts'))};
       import { REQUIRED_BUN } from ${JSON.stringify(join(import.meta.dir, 'app-root.ts'))};
       import { exec } from ${JSON.stringify(join(import.meta.dir, 'exec.ts'))};
       import { parseArgs } from ${JSON.stringify(join(import.meta.dir, 'parse.ts'))};
       import { SPECS } from ${JSON.stringify(join(import.meta.dir, 'registry.ts'))};
       for (const table of ['fork_one', 'fork_two']) entity(table, { columns: { id: uuid().primaryKey() } });
       const result = await dbCommand.run({
         args: parseArgs(['db', 'gen', 'create one'], SPECS),
         cwd: ${JSON.stringify(root)},
         runner: exec,
         env: Bun.env,
         bunVersion: REQUIRED_BUN,
       });
       console.log(JSON.stringify({ ok: result.ok, summary: result.summary }));`,
    ],
    { cwd: import.meta.dir, env, stdout: 'pipe', stderr: 'pipe', timeout: REPLAY_MS },
  );

// flock(2) does not exist there, so the ledger and this lock are off (`heavy-flock.ts`).
describe.skipIf(process.platform === 'win32')('x db gen in one checkout', () => {
  test(
    'a run waits for the one in progress, then sees its migration and writes none',
    async () => {
      const restore = isolateEntityRegistry();
      const root = await appRoot();
      const ledger = mkdtempSync(join(tmpdir(), 'x-db-fork-ledger-'));
      // `CI` cleared and a ledger of its own: this lock is the machine ledger's, off under CI.
      const env = { CI: '', [HEAVY_DIR_ENV]: ledger };
      const childEnv = { ...Bun.env, ...env } as Record<string, string>;
      try {
        declare('fork_one', 'fork_two');
        const child = await withCheckoutLock(
          { name: 'db-gen', root, env },
          { env: {}, fds: [] },
          async () => {
            const started = genInChild(root, childEnv);
            // Without the lock the child finishes here and the stream ends with no such line.
            expect(await sawLine(started.stderr, 'db-gen lock')).toBe(true);
            expect(await readMigrations(root)).toEqual([]);
            return started;
          },
        );
        expect(await child.exited).toBe(0);
        const body = JSON.parse(await new Response(child.stdout).text()) as {
          readonly summary: string;
        };
        const migrations = await readMigrations(root);
        expect(migrations).toHaveLength(1);
        const id = migrations[0]?.id ?? expect.unreachable('one migration was written');
        expect(body.summary).toBe(
          msg('cli.db.gen.writtenTables', { id, tables: 'fork_one, fork_two' }),
        );

        const later = await dbCommand.run(ctxFor(['db', 'gen', 'create two'], root, env));
        expect(later.ok).toBe(true);
        expect(later.data).toMatchObject({ migration: null, newest: id });
        expect(later.lines).toContain(msg('cli.db.gen.newest', { id }));
        expect(await readMigrations(root)).toHaveLength(1);
      } finally {
        rmSync(root, { recursive: true, force: true });
        rmSync(ledger, { recursive: true, force: true });
        restore();
      }
    },
    REPLAY_MS,
  );
});
