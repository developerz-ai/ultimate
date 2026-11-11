#!/usr/bin/env bun
// The plan's large app, booted whole (plan 101 slice 22, done-when): `x dev` from spawn to the
// first 200 on `/`, and a production `web` pod from the prebuilt registry to the same — wall clock
// and the process group's peak RSS, the median of `--runs` boots each. `boot-vs-files.bench.ts`
// times module import alone; this times everything a developer and a rollout wait for.
//
//   bun run scripts/bench/boot-large-app.bench.ts [--resources 150] [--runs 3] [--keep] [--reuse]
//     [--database-url <postgres server url>] [--port 3901] [--out <file.json>] [--json]
//
// The pod half needs a Postgres server: `--database-url`, else `TEST_DATABASE_URL`
// (`docker compose -f docker/docker-compose.test.yml up -d --wait`). The app is written under
// the root's ignored `.x/bench-large-app/` and deleted after the run (its 5,000 files hold tests a
// root `bun test` would find); `--keep` leaves it, and `--reuse` boots the one a `--keep` left.

// why: Bun ships no load average or recursive delete of its own.
import { rm } from 'node:fs/promises';
import { loadavg } from 'node:os';
import { parseScriptArgs } from '../lib/args';
import { repoRoot } from '../lib/run';
import { ScriptError } from '../lib/script-error';
import { strangerEnvAt } from '../lib/stranger-env';
import {
  appShape,
  fixtureDir,
  fixtureParent,
  writeLargeApp,
  X_BIN,
} from './boot-large-app-fixture';
import type { PodResult } from './boot-large-app-pod';
import { benchPod } from './boot-large-app-pod';
import { timeBoot } from './boot-large-app-proc';
import type { AppShape, Boot, BootSummary } from './boot-large-app-shape';
import { DEFAULT_RESOURCES, summarise, verdict } from './boot-large-app-shape';
import { boxFacts, readCount } from './http-hello';

/** The plan's done-when, in milliseconds. */
export const DEV_TARGET_MS = 10_000;
export const POD_TARGET_MS = 3_000;

export interface LargeAppArgs {
  readonly resources: number;
  readonly runs: number;
  readonly reuse: boolean;
  readonly keep: boolean;
  readonly port: number;
  readonly databaseUrl: string | undefined;
  readonly out: string | undefined;
  readonly json: boolean;
}

/** The flags, or `X_CLI_BAD_FLAG` naming them. */
export function largeAppArgs(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>> = Bun.env,
): LargeAppArgs {
  const args = parseScriptArgs(argv);
  const resources = readCount(args.flags.get('resources'), DEFAULT_RESOURCES, {
    flag: 'resources',
    min: 0,
    max: 1_000,
  });
  const runs = readCount(args.flags.get('runs'), 3, { flag: 'runs', min: 1, max: 15 });
  const port = readCount(args.flags.get('port'), 3901, { flag: 'port', min: 1024, max: 65_000 });
  if (typeof resources !== 'number' || typeof runs !== 'number' || typeof port !== 'number') {
    throw new ScriptError({
      code: 'X_CLI_BAD_FLAG',
      cause: 'boot-large-app takes --resources 0..1000, --runs 1..15 and --port 1024..65000',
      fix: 'bun run scripts/bench/boot-large-app.bench.ts --resources 150 --runs 3',
    });
  }
  const flag = (name: string): string | undefined => {
    const value = args.flags.get(name);
    return typeof value === 'string' ? value : undefined;
  };
  return {
    resources,
    runs,
    port,
    reuse: args.flags.get('reuse') === true,
    keep: args.flags.get('keep') === true,
    databaseUrl: flag('database-url') ?? env['TEST_DATABASE_URL'],
    out: flag('out'),
    json: args.json,
  };
}

/**
 * The dev child's env: the stranger's (`strangerEnvAt`) without `DATABASE_URL`, which it fills from
 * `TEST_DATABASE_URL` — on an external database `x dev` boots with no replicator and refuses
 * (`X_REALTIME_TOPOLOGY`). The boot timed is the embedded one a developer runs.
 */
export function devEnv(
  stranger: Readonly<Record<string, string>>,
  port: number,
): Record<string, string> {
  const env = Object.fromEntries(
    Object.entries(stranger).filter(([key]) => key !== 'DATABASE_URL'),
  );
  return { ...env, METRICS_PORT: String(port + 2) };
}

/** `runs` `x dev` boots; `cold` deletes the app's `.x/` state (the embedded Postgres) first. */
async function benchDev(dir: string, runs: number, port: number, cold: boolean) {
  const boots: Boot[] = [];
  for (let run = 0; run < runs; run += 1) {
    if (cold) await rm(`${dir}/.x`, { recursive: true, force: true });
    boots.push(
      await timeBoot({
        cmd: ['bun', X_BIN(), 'dev', '--port', String(port)],
        cwd: dir,
        env: devEnv(strangerEnvAt(repoRoot()), port),
        url: `http://127.0.0.1:${String(port)}/`,
        timeoutMs: 300_000,
      }),
    );
  }
  return summarise(boots);
}

export interface LargeAppResult {
  readonly box: ReturnType<typeof boxFacts> & { readonly loadAvg1m: number };
  readonly runs: number;
  readonly app: AppShape;
  readonly dev: {
    readonly targetMs: number;
    readonly verdict: 'met' | 'missed';
    /** A fresh process over the `.x/` state the previous boot left: a restart. The verdict's. */
    readonly warm: BootSummary;
    /** `.x/` deleted first: the first boot on a clone, its embedded Postgres made and migrated. */
    readonly cold: BootSummary;
  };
  readonly pod:
    | (PodResult & { readonly targetMs: number; readonly verdict: 'met' | 'missed' })
    | { readonly skipped: string };
}

/**
 * `work` over the fixture under `parent`, which is removed afterwards — when `work` throws too —
 * unless `keep`: its 5,000 generated files hold tests a root `bun test` would find.
 */
export async function withFixture<T>(
  parent: string,
  keep: boolean,
  work: () => Promise<T>,
): Promise<T> {
  try {
    return await work();
  } finally {
    if (!keep) await rm(parent, { recursive: true, force: true });
  }
}

/** Every figure, on the app under `dir` (written fresh unless `--reuse` finds one). */
async function measure(dir: string, args: LargeAppArgs): Promise<LargeAppResult> {
  const reuse = args.reuse && (await Bun.file(`${dir}/x.manifest.json`).exists());
  if (!reuse) await writeLargeApp(args.resources, dir);
  const app = await appShape(dir, args.resources);
  const load = loadavg()[0] ?? 0;
  // The first boot of a fresh tree also makes `.x/`: it is the cold set's to time, never the warm's.
  const cold = await benchDev(dir, args.runs, args.port, true);
  const warm = await benchDev(dir, args.runs, args.port, false);
  const pod =
    args.databaseUrl === undefined
      ? { skipped: 'no --database-url and no TEST_DATABASE_URL: the pod boots against Postgres' }
      : await benchPod(dir, args.runs, args.databaseUrl, args.port + 10).then((result) => ({
          ...result,
          targetMs: POD_TARGET_MS,
          verdict: verdict(result.registry.medianMs, POD_TARGET_MS),
        }));
  return {
    box: { ...boxFacts(Bun.env), loadAvg1m: Math.round(load * 10) / 10 },
    runs: args.runs,
    app,
    dev: { targetMs: DEV_TARGET_MS, verdict: verdict(warm.medianMs, DEV_TARGET_MS), warm, cold },
    pod,
  };
}

export async function runLargeAppBench(
  argv: readonly string[],
  log: (line: string) => void = console.log,
): Promise<LargeAppResult> {
  const args = largeAppArgs(argv);
  const result = await withFixture(fixtureParent(), args.keep, () => measure(fixtureDir(), args));
  const { app, dev, pod } = result;
  if (args.out !== undefined) await Bun.write(args.out, `${JSON.stringify(result, null, 2)}\n`);
  if (args.json) log(JSON.stringify(result, null, 2));
  else {
    log(`${String(app.tsFiles)} TS files, ${String(app.resources)} generated resources`);
    log(
      `x dev warm: ${String(dev.warm.medianMs)} ms, ${String(dev.warm.medianPeakRssMb)} MiB peak`,
    );
    log(
      `x dev cold: ${String(dev.cold.medianMs)} ms, ${String(dev.cold.medianPeakRssMb)} MiB peak`,
    );
    if ('registry' in pod) {
      log(
        `pod (registry): ${String(pod.registry.medianMs)} ms; scan: ${String(pod.scan.medianMs)}`,
      );
    } else log(`pod: skipped — ${pod.skipped}`);
  }
  return result;
}

if (import.meta.main) await runLargeAppBench(Bun.argv.slice(2));
