// Single responsibility: what a test run leaves behind, swept — the framework's DatabaseCleaner and
// `tmp:clear` in one place, so an app never accumulates it (#738: one app held 72 migrated
// templates, 4.2 GB, and `.x/cache` folders beside its source). Two callers, one rule:
//
// - the test runner, before every run (`'auto'`): the two newest templates and PGlite snapshots
//   stay — the current state and the one a second checkout or an older branch may be reading;
// - `x clean` (`'all'`): every template and the whole `.x/cache`, on demand, `--dry-run` to look.
//
// Both remove the `.x` debris a process started in a source folder used to write beside the code,
// and with `TEST_DATABASE_URL` set, every probe database whose run is provably over. What a
// developer works in is never touched: `.x/pgdata` (the dev database), `.x/storage`, the build.

// why: Bun has no readdir, rmdir or recursive remove.
import { readdir, rm, rmdir } from 'node:fs/promises';
// why: Bun ships no path joiner.
import { join } from 'node:path';
import type { PgExecutor, ProbeDatabaseSweepOptions } from '@ultimat3/core';
import {
  APP_CONFIG_FILE,
  APP_STATE_DIR,
  appDirOf,
  evictCacheFiles,
  sweepStaleProbeDatabases,
} from '@ultimat3/core';
import { dbExecutor, postgresClient } from '@ultimat3/db';
import { TEST_DB_DIR } from './test-db-template';

export type HousekeepingMode = 'auto' | 'all';

export interface ProbeServer {
  readonly executor: PgExecutor;
  close(): Promise<void>;
}

export interface HousekeepingOptions extends ProbeDatabaseSweepOptions {
  /** The app root, or any folder in it. */
  readonly root: string;
  readonly mode: HousekeepingMode;
  /** Name what would go and remove nothing. */
  readonly dryRun?: boolean;
  /** Where `TEST_DATABASE_URL` is read; without it no database is swept and nothing connects. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Seam: how the probe server is reached. Defaults to a one-connection pool. */
  readonly connect?: (url: string) => Promise<ProbeServer>;
}

export interface HousekeepingReport {
  /** Every file and directory removed (or, dry, that would be). */
  readonly paths: readonly string[];
  /** Every probe database dropped (or, dry, that would be). */
  readonly databases: readonly string[];
}

/** Entries of each cache an `'auto'` sweep keeps: the current state and the newest previous one. */
const AUTO_KEEP = 2;

const TEMPLATE = /^pglite-[0-9a-f]{16}\.tar$/;
const TEMPLATE_PARTIAL = /^pglite-[0-9a-f]{16}\.tar\..+\.partial$/;
const SNAPSHOT = /^pglite-.+\.snapshot$/;
const SNAPSHOT_TEMP = /^pglite-.+\.snapshot\..+\.tmp$/;

/** Folders a walk for stray `.x` never enters: dependencies, history, and the app's own state. */
const NEVER_WALKED = new Set(['node_modules', '.git', APP_STATE_DIR]);

/** The bound on a probe server that does not answer: housekeeping never holds a run up. */
const CONNECT_BUDGET_MS = 5_000;

const defaultConnect = async (url: string): Promise<ProbeServer> => {
  const client = postgresClient({ url, role: 'web', profile: { max: 1 } });
  return { executor: dbExecutor(() => client), close: () => client.close() };
};

/**
 * `.x` folders below `root` that are not an app's own: the cache a process started in a source
 * folder wrote beside the code. A folder holding its own `app.config.ts` is another app, whose
 * `.x` is its own, and is not walked into.
 */
async function strayStateDirs(root: string): Promise<readonly string[]> {
  const found: string[] = [];
  const walk = async (dir: string, top: boolean): Promise<void> => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (!top && entries.some((entry) => entry.isFile() && entry.name === APP_CONFIG_FILE)) return;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === APP_STATE_DIR && !top) found.push(join(dir, entry.name));
      if (NEVER_WALKED.has(entry.name)) continue;
      await walk(join(dir, entry.name), false);
    }
  };
  await walk(root, true);
  return found;
}

/** The stray `.x`'s `cache` goes — the only thing the bug wrote — and the `.x` itself once empty. */
async function sweepStray(dir: string, dryRun: boolean): Promise<readonly string[]> {
  const entries = await readdir(dir).catch(() => [] as string[]);
  const onlyCache = entries.every((name) => name === 'cache');
  const removed = onlyCache ? [dir] : entries.includes('cache') ? [join(dir, 'cache')] : [];
  if (!dryRun) {
    for (const path of removed) await rm(path, { recursive: true, force: true });
    if (!onlyCache) await rmdir(dir).catch(() => undefined);
  }
  return removed;
}

async function sweepDatabases(options: HousekeepingOptions): Promise<readonly string[]> {
  const url = options.env['TEST_DATABASE_URL'];
  if (url === undefined || url.trim().length === 0) return [];
  let server: ProbeServer | undefined;
  try {
    server = await (options.connect ?? defaultConnect)(url);
    const connected = server;
    const swept = sweepStaleProbeDatabases(connected.executor, {
      ...(options.isAlive === undefined ? {} : { isAlive: options.isAlive }),
      ...(options.now === undefined ? {} : { now: options.now }),
      dryRun: options.dryRun === true,
    });
    const late = Bun.sleep(CONNECT_BUDGET_MS).then(() => [] as readonly string[]);
    return await Promise.race([swept, late]);
  } catch {
    // Best effort: an unreachable server costs the sweep its databases, never the test run.
    return [];
  } finally {
    await server?.close().catch(() => undefined);
  }
}

/** Sweep what tests leave behind under the app containing `options.root`. */
export async function tidyTestState(options: HousekeepingOptions): Promise<HousekeepingReport> {
  const app = appDirOf(options.root);
  const root = app ?? options.root;
  const state = join(root, APP_STATE_DIR);
  const dryRun = options.dryRun === true;
  const keep = options.mode === 'all' ? 0 : AUTO_KEEP;
  const paths: string[] = [
    ...(await evictCacheFiles({
      dir: join(state, TEST_DB_DIR),
      current: undefined,
      keepPrevious: keep,
      matches: (name) => TEMPLATE.test(name),
      temporary: (name) => TEMPLATE_PARTIAL.test(name),
      dryRun,
    })),
  ];
  if (options.mode === 'all') {
    const cache = join(state, 'cache');
    if ((await readdir(cache).catch(() => undefined)) !== undefined) {
      paths.push(cache);
      if (!dryRun) await rm(cache, { recursive: true, force: true });
    }
  } else {
    paths.push(
      ...(await evictCacheFiles({
        dir: join(state, 'cache'),
        current: undefined,
        keepPrevious: keep,
        matches: (name) => SNAPSHOT.test(name),
        temporary: (name) => SNAPSHOT_TEMP.test(name),
        dryRun,
      })),
    );
  }
  // Only inside an app: outside one (a package's own folder) a `.x` below is that folder's state.
  if (app !== undefined) {
    for (const stray of await strayStateDirs(root))
      paths.push(...(await sweepStray(stray, dryRun)));
  }
  return { paths, databases: await sweepDatabases(options) };
}

/** Roots this process already swept: `x verify` runs several test steps, and one sweep serves all. */
const swept = new Set<string>();

/**
 * The test runner's call, before it spawns `bun test` (`x test`, and every test step of `x verify`):
 * the `'auto'` sweep, once per app per process. Never a reason for a run to fail — housekeeping
 * that throws is logged nowhere and costs nothing but the leftovers it did not remove.
 */
export async function tidyBeforeTestRun(
  root: string,
  env: Readonly<Record<string, string | undefined>>,
  tidy: (options: HousekeepingOptions) => Promise<HousekeepingReport> = tidyTestState,
): Promise<void> {
  const key = appDirOf(root) ?? root;
  if (swept.has(key)) return;
  swept.add(key);
  try {
    await tidy({ root: key, mode: 'auto', env });
  } catch {
    // Best effort, by design: see above.
  }
}
