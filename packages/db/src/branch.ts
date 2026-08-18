// Single responsibility: copy-on-write branch databases. `CREATE DATABASE ... TEMPLATE` gives an
// agent (or a preview environment) a private copy in seconds, so destructive work — a migration
// it is unsure about, a data backfill, a DROP — never happens against the shared database.
// Branches are cheap and forgettable, so `reapBranches()` is part of the design, not an add-on.

import { systemClock } from '@ultimat3/core';
import { baseClient, type DbClient } from './client';
import { branchExists, branchNameInvalid, DbError } from './errors';
import { identifier, literal, sql } from './sql';

const BRANCH_NAME = /^[a-z0-9_-]+$/;

/** Written as a database comment at creation time — `pg_database` has no created_at. */
const BRANCH_MARKER = 'ultimate:branch:';

export interface BranchInfo {
  readonly name: string;
  readonly createdAt: string | null;
  readonly sizeBytes: number;
}

export function assertBranchName(branch: string): string {
  if (!BRANCH_NAME.test(branch)) throw branchNameInvalid(branch);
  return branch;
}

export interface BranchOptions {
  readonly client?: DbClient | undefined;
  /** The database to copy. Defaults to the current one. */
  readonly base?: string | undefined;
  readonly now?: Date | undefined;
}

async function exists(client: DbClient, branch: string): Promise<boolean> {
  const row = await client.one<{ ok: number }>(
    sql`select 1 as ok from pg_database where datname = ${branch}`,
  );
  return row !== null;
}

/**
 * `CREATE DATABASE` cannot run inside a transaction and needs no other session connected to the
 * template, so this deliberately runs statement-by-statement on the ambient client.
 */
export async function createBranch(
  branch: string,
  options: BranchOptions = {},
): Promise<BranchInfo> {
  const client = options.client ?? baseClient();
  assertBranchName(branch);
  if (await exists(client, branch)) throw branchExists(branch);

  const base = options.base ?? (await currentDatabase(client));
  await client.execute(sql`create database ${identifier(branch)} template ${identifier(base)}`);
  const createdAt = (options.now ?? systemClock.now()).toISOString();
  await client.execute(
    sql`comment on database ${identifier(branch)} is ${literal(`${BRANCH_MARKER}${createdAt}`)}`,
  );
  return { name: branch, createdAt, sizeBytes: 0 };
}

export async function currentDatabase(client: DbClient = baseClient()): Promise<string> {
  const row = await client.one<{ name: string }>(sql`select current_database() as name`);
  return row?.name ?? 'postgres';
}

interface BranchRow {
  readonly name: string;
  readonly comment: string | null;
  readonly size_bytes: string | number;
}

export async function listBranches(options: BranchOptions = {}): Promise<readonly BranchInfo[]> {
  const client = options.client ?? baseClient();
  const rows = await client.query<BranchRow>(sql`
    select
      d.datname as name,
      shobj_description(d.oid, 'pg_database') as comment,
      pg_database_size(d.datname) as size_bytes
    from pg_database d
    where not d.datistemplate
    order by d.datname
  `);
  return rows
    .filter((row) => row.comment?.startsWith(BRANCH_MARKER) === true)
    .map((row) => ({
      name: row.name,
      createdAt: row.comment?.slice(BRANCH_MARKER.length) ?? null,
      sizeBytes: Number(row.size_bytes),
    }));
}

export interface DropBranchOptions extends BranchOptions {
  /** Disconnect other sessions first. Without it Postgres refuses while anyone is connected. */
  readonly force?: boolean | undefined;
}

export async function dropBranch(
  branch: string,
  options: DropBranchOptions = {},
): Promise<boolean> {
  const client = options.client ?? baseClient();
  assertBranchName(branch);
  if (branch === (await currentDatabase(client))) {
    throw new DbError({
      code: 'X_BRANCH_EXISTS',
      cause: `"${branch}" is the database this session is connected to, so it cannot be dropped`,
      fix: 'connect to another database (DATABASE_URL=.../postgres) and drop it from there',
      meta: { branch },
    });
  }
  if (options.force === true) {
    await client.execute(sql`
      select pg_terminate_backend(pid) from pg_stat_activity where datname = ${branch}
    `);
  }
  // Asked BEFORE the statement, because `drop database if exists` answers with the same command
  // tag either way and `execute` counts no rows for it: `affected >= 0` was `true` by
  // construction, so the boolean could not tell a branch that was dropped from a name that was
  // never a database — which is the one question a reaper or a preview teardown asks it.
  const existed = await exists(client, branch);
  await client.execute(sql`drop database if exists ${identifier(branch)}`);
  return existed;
}

export interface ReapOptions extends DropBranchOptions {
  readonly maxAgeMs: number;
}

/** Preview environments leak branches; this is what the nightly `reapBranches` task calls. */
export async function reapBranches(options: ReapOptions): Promise<readonly string[]> {
  const cutoff = (options.now ?? systemClock.now()).getTime() - options.maxAgeMs;
  const branches = await listBranches(options);
  const dropped: string[] = [];
  for (const branch of branches) {
    if (branch.createdAt === null) continue;
    const createdAtMs = Date.parse(branch.createdAt);
    // `NaN > cutoff` is `false`, which is the same answer "older than the cutoff" gives — so a
    // truncated or hand-edited comment used to be a database DROPPED on the next sweep, whatever
    // `maxAgeMs` said. An age nothing can read is not an old age.
    if (!Number.isFinite(createdAtMs) || createdAtMs > cutoff) continue;
    await dropBranch(branch.name, options);
    dropped.push(branch.name);
  }
  return dropped;
}
