// The pod half of `boot-large-app.bench.ts`: the large app booted the way its image boots a `web`
// pod — `x build --target prebuilt` (the Dockerfile's `RUN`), `x env init --production`'s secrets,
// `ROLE=migrate` once against a real Postgres, then `bun apps/web/server.ts` with `ROLE=web` and
// `NODE_ENV=production` — timed to its first 200 on `/`. On the host, not in a container: the same
// entry, store and env the image runs, without the image's own layer and cgroup costs.

// why: Bun ships no rename of its own.
import { rename } from 'node:fs/promises';
import { quoteArg } from '../../packages/cli/src/shell-quote';
import { repoRoot } from '../lib/run';
import { ScriptError } from '../lib/script-error';
import { strangerEnvAt } from '../lib/stranger-env';
import { runOrThrow, X_BIN } from './boot-large-app-fixture';
import { timeBoot } from './boot-large-app-proc';
import type { BootSummary } from './boot-large-app-shape';
import { summarise } from './boot-large-app-shape';

export const POD_DATABASE = 'bench_boot_large';

/** `KEY=value` lines of an env file; comments and blanks skipped. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    const at = trimmed.indexOf('=');
    if (trimmed === '' || trimmed.startsWith('#') || at < 1) continue;
    out[trimmed.slice(0, at)] = trimmed.slice(at + 1);
  }
  return out;
}

/** `serverUrl` with its database swapped for `name` — the bench's own, created fresh. */
export function databaseUrl(serverUrl: string, name: string): string {
  const url = new URL(serverUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

async function freshDatabase(serverUrl: string): Promise<string> {
  const sql = new Bun.SQL(serverUrl);
  try {
    await sql.unsafe(`drop database if exists ${POD_DATABASE} with (force)`);
    await sql.unsafe(`create database ${POD_DATABASE}`);
  } finally {
    await sql.close();
  }
  return databaseUrl(serverUrl, POD_DATABASE);
}

export interface PodResult {
  /** `x build --target prebuilt` on the large app: the image build's step, once. */
  readonly prebuildMs: number;
  /** Booted from the prebuilt registry — what every pod start does. */
  readonly registry: BootSummary;
  /** The same boot with the registry moved aside, so the role scans the app: the before. */
  readonly scan: BootSummary;
}

/** Prebuild, migrate, then `runs` web boots from the registry and `runs` without it. */
export async function benchPod(
  dir: string,
  runs: number,
  serverUrl: string,
  port: number,
): Promise<PodResult> {
  const started = performance.now();
  runOrThrow(['bun', X_BIN(), 'build', '--target', 'prebuilt'], dir, 'x build --target prebuilt');
  const prebuildMs = Math.round(performance.now() - started);
  if (!(await Bun.file(`${dir}/.env.production`).exists())) {
    runOrThrow(['bun', X_BIN(), 'env', 'init', '--production', '--json'], dir, 'x env init');
  }
  const secrets = parseEnvFile(await Bun.file(`${dir}/.env.production`).text());
  const env = strangerEnvAt(repoRoot(), {
    ...secrets,
    NODE_ENV: 'production',
    DATABASE_URL: await freshDatabase(serverUrl),
    BUILD_ID: 'bench-boot-large-app',
    PORT: String(port),
    METRICS_PORT: String(port + 1),
  });
  const migrate = Bun.spawnSync(['bun', 'apps/web/server.ts'], {
    cwd: dir,
    env: { ...env, ROLE: 'migrate' },
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 300_000,
  });
  if (migrate.exitCode !== 0) {
    throw new ScriptError({
      code: 'X_BENCH_RUN_FAILED',
      cause: `ROLE=migrate exited ${String(migrate.exitCode)}: ${migrate.stderr.toString().slice(-600)}`,
      fix: `cd ${quoteArg(dir)} && ROLE=migrate NODE_ENV=production bun apps/web/server.ts`,
    });
  }
  const boot = () =>
    timeBoot({
      cmd: ['bun', 'apps/web/server.ts'],
      cwd: dir,
      env: { ...env, ROLE: 'web' },
      url: `http://127.0.0.1:${String(port)}/`,
      timeoutMs: 120_000,
    });
  const registry = [];
  for (let run = 0; run < runs; run += 1) registry.push(await boot());
  const store = `${dir}/node_modules/.cache/ultimate/registry`;
  await rename(store, `${store}.aside`);
  const scan = [];
  try {
    for (let run = 0; run < runs; run += 1) scan.push(await boot());
  } finally {
    await rename(`${store}.aside`, store);
  }
  return { prebuildMs, registry: summarise(registry), scan: summarise(scan) };
}
