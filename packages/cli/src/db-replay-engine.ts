// Which database the schema dump is replayed on, and that database, opened and thrown away. ONE
// rule: the embedded database, unless the migrations create an extension it cannot link — then a
// real Postgres, in a database this module creates and drops. Decided from the migrations and the
// installed PGlite alone, never from which URL happens to be set, so a laptop and CI choose alike.

// why: Bun ships no path joiner.
import { join } from 'node:path';
import type { DbClient, LinkedExtensions, Migration } from '@ultimat3/db';
import { DbError, linkPgliteExtensions, pgliteClient, postgresClient, raw } from '@ultimat3/db';
import { migrationExtensions } from './migration-extensions';

type Env = Readonly<Record<string, string | undefined>>;

/**
 * Where a real Postgres is looked for, in order — the admin URL `@ultimat3/testing` already
 * clones its template databases from (`template-db.ts`), so a CI that runs the `live` suite has
 * it set and nothing new to configure.
 */
export const REPLAY_URL_ENVS = ['TEST_DATABASE_URL', 'DATABASE_URL'] as const;

export type ReplayEngine =
  | { readonly kind: 'embedded'; readonly extensions: readonly string[] }
  | {
      readonly kind: 'postgres';
      readonly adminUrl: string;
      /** The extensions that forced it, for the finding a missing URL becomes. */
      readonly requires: readonly string[];
    };

/**
 * The migrations need a server and none is named. `X_SCHEMA_DUMP_DRIFT`, because the dump cannot
 * be produced or held; the cause names the extension, the fix the variable and the command.
 */
export function replayServerMissing(requires: readonly string[]): DbError {
  const named = requires.map((name) => `"${name}"`).join(', ');
  return new DbError({
    code: 'X_SCHEMA_DUMP_DRIFT',
    cause: `the migrations create extension ${named}, which the embedded database cannot link, so the schema dump is replayed on a real Postgres — and neither ${REPLAY_URL_ENVS.join(' nor ')} names one`,
    fix: `${REPLAY_URL_ENVS[0]}=postgres://<user>:<password>@localhost:5432/postgres x db gen   # a server with that extension installed, and a role that may create a database`,
    meta: { kind: 'engine-unavailable', extensions: [...requires] },
  });
}

export type ExtensionLinker = (names: readonly string[]) => Promise<LinkedExtensions>;

/** The rule. Throws `replayServerMissing` when it selects a server nobody named. */
export async function chooseReplayEngine(
  migrations: readonly Migration[],
  env: Env,
  link: ExtensionLinker = linkPgliteExtensions,
): Promise<ReplayEngine> {
  const extensions = migrationExtensions(migrations);
  const { missing } = await link(extensions);
  if (missing.length === 0) return { kind: 'embedded', extensions };
  const adminUrl = REPLAY_URL_ENVS.map((name) => env[name]).find(
    (value) => value !== undefined && value.length > 0,
  );
  if (adminUrl === undefined) throw replayServerMissing(missing);
  return { kind: 'postgres', adminUrl, requires: missing };
}

/** Unique per call: two `x db gen` runs against one server must not share a scratch database. */
const scratchName = (): string => `x_schema_dump_${process.pid}_${crypto.randomUUID().slice(0, 8)}`;

async function withPostgresScratch<T>(
  adminUrl: string,
  work: (client: DbClient) => Promise<T>,
): Promise<T> {
  const database = scratchName();
  const admin = postgresClient({ url: adminUrl });
  try {
    // `template0`: the server's `template1` may carry objects an operator put there, and they
    // would be dumped as the app's.
    await admin.execute(raw(`create database ${database} template template0`));
    const target = new URL(adminUrl);
    target.pathname = `/${database}`;
    const client = postgresClient({ url: target.toString() });
    try {
      return await work(client);
    } finally {
      await client.close();
      await admin.execute(raw(`drop database if exists ${database} with (force)`));
    }
  } finally {
    await admin.close();
  }
}

/**
 * Run `work` against an empty scratch database on `engine`, and release it. The embedded one
 * boots from the snapshot cache under `stateDir`, so only the first boot per PGlite version runs
 * `initdb`.
 */
export async function withScratchDatabase<T>(
  engine: ReplayEngine,
  stateDir: string | undefined,
  work: (client: DbClient) => Promise<T>,
): Promise<T> {
  if (engine.kind === 'postgres') return withPostgresScratch(engine.adminUrl, work);
  const client = pgliteClient({
    extensions: engine.extensions,
    ...(stateDir === undefined ? {} : { snapshotDir: join(stateDir, 'cache') }),
  });
  try {
    return await work(client);
  } finally {
    await client.close();
  }
}
