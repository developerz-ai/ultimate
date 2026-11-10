#!/usr/bin/env bun
// Requests per second against the PRODUCTION image — `x build --target docker`, deployed by
// `x deploy` on the app's own `docker/docker-compose.prod.yml` — at 1 and at N `web` pods. Pod 1 is
// the Compose `web` service; pods 2..N are `docker compose run --no-deps` copies of it (same image,
// env, network and database) each on its own host port, because Compose publishes a port to one
// binder (`17-scale-ladder.md`, rung 2) and a proxy in front would be the proxy's figure. The
// fleet's figure is the SUM of one load loop per pod, run at once from this process.
//
//   KEEP_STACK=1 WORK=<dir> bash docker/deploy-proof/compose.sh     # the app and its stack
//   bun run scripts/bench/http-prod-image.bench.ts --app <dir>/proofapp [--pods 1,3]
//     [--path /] [--seconds 30] [--concurrency 16] [--out <file.json>] [--json]
//
// The scaffold's read bucket must be raised before the image is built (bench.yml's step does the
// same for `x dev`): one client past a 120-request burst is a 429, and a 429 is not a figure.

import { parseScriptArgs } from '../lib/args';
import { ScriptError } from '../lib/script-error';
import { boxFacts, MIN_SECONDS, readCount } from './http-hello';
import { type LoadResult, loadVerdict, runLoad } from './http-hello-load';

const BASE_PORT = 3000;
const READY_TIMEOUT_MS = 60_000;
const COMPOSE = [
  'docker',
  'compose',
  '--env-file',
  '.env.production',
  '-f',
  'docker/docker-compose.prod.yml',
];

const failed = (cause: string): ScriptError =>
  new ScriptError({
    code: 'X_BENCH_RUN_FAILED',
    cause,
    fix: 'KEEP_STACK=1 bash docker/deploy-proof/compose.sh   # then re-run this bench with --app on its proofapp',
  });

const answerFetch = async (url: string) => {
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  return { status: response.status, bytes: (await response.arrayBuffer()).byteLength };
};

async function ready(port: number): Promise<void> {
  const started = performance.now();
  while (performance.now() - started < READY_TIMEOUT_MS) {
    const status = await answerFetch(`http://127.0.0.1:${String(port)}/readyz`).then(
      (answer) => answer.status,
      () => 0,
    );
    if (status === 200) return;
    await Bun.sleep(250);
  }
  throw failed(`the web pod on :${String(port)} never answered /readyz 200`);
}

/** Pods 2..n: the Compose `web` service run again, detached, on the next host ports. */
function extraPods(app: string, pods: number): readonly string[] {
  return Array.from({ length: pods - 1 }, (_, index) => {
    const port = BASE_PORT + index + 1;
    const run = Bun.spawnSync(
      [...COMPOSE, 'run', '-d', '--no-deps', '-p', `127.0.0.1:${String(port)}:3000`, 'web'],
      { cwd: app, timeout: 120_000 },
    );
    const id = run.stdout.toString().trim().split('\n').pop() ?? '';
    if (run.exitCode !== 0 || id.length === 0) {
      throw failed(
        `docker compose run web on :${String(port)} failed: ${run.stderr.toString().slice(0, 300)}`,
      );
    }
    return id;
  });
}

export interface PodsRun {
  readonly pods: number;
  readonly rps: number;
  readonly worstP50Ms: number;
  readonly worstP99Ms: number;
  readonly perPod: readonly LoadResult[];
}

export async function benchPods(
  app: string,
  pods: number,
  path: string,
  seconds: number,
  concurrency: number,
): Promise<PodsRun> {
  const extra = extraPods(app, pods);
  try {
    const ports = Array.from({ length: pods }, (_, index) => BASE_PORT + index);
    await Promise.all(ports.map(ready));
    const perPod = await Promise.all(
      ports.map((port) =>
        runLoad({
          url: `http://127.0.0.1:${String(port)}${path}`,
          concurrency,
          durationMs: seconds * 1_000,
          fetch: answerFetch,
          now: () => performance.now(),
        }),
      ),
    );
    const refused = perPod.flatMap(loadVerdict);
    if (refused.length > 0) throw failed(`${String(pods)} pods: ${refused.join('; ')}`);
    return {
      pods,
      rps: Math.round(perPod.reduce((sum, pod) => sum + pod.rps, 0)),
      worstP50Ms: Math.max(...perPod.map((pod) => pod.p50Ms)),
      worstP99Ms: Math.max(...perPod.map((pod) => pod.p99Ms)),
      perPod,
    };
  } finally {
    if (extra.length > 0) Bun.spawnSync(['docker', 'rm', '-f', ...extra], { timeout: 60_000 });
  }
}

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const app = args.flags.get('app');
  const rawPods = args.flags.get('pods');
  const podCounts = typeof rawPods === 'string' ? rawPods.split(',').map(Number) : [1, 3];
  const path = args.flags.get('path');
  const seconds = readCount(args.flags.get('seconds'), 30, {
    flag: 'seconds',
    min: MIN_SECONDS,
    max: 600,
  });
  const concurrency = readCount(args.flags.get('concurrency'), 16, {
    flag: 'concurrency',
    min: 1,
    max: 256,
  });
  if (
    typeof app !== 'string' ||
    typeof seconds !== 'number' ||
    typeof concurrency !== 'number' ||
    !podCounts.every((n) => Number.isInteger(n) && n >= 1 && n <= 8)
  ) {
    throw new ScriptError({
      code: 'X_CLI_BAD_FLAG',
      cause:
        'http-prod-image needs --app (a deployed scaffold), --pods as whole numbers 1..8 and --seconds ≥ 10',
      fix: 'bun run scripts/bench/http-prod-image.bench.ts --app <work>/proofapp --pods 1,3',
    });
  }
  const target = typeof path === 'string' ? path : '/';
  const runs: PodsRun[] = [];
  for (const pods of podCounts) runs.push(await benchPods(app, pods, target, seconds, concurrency));
  const data = {
    box: boxFacts(Bun.env),
    path: target,
    seconds,
    concurrencyPerPod: concurrency,
    runs,
  };
  const out = args.flags.get('out');
  if (typeof out === 'string') await Bun.write(out, `${JSON.stringify(data, null, 2)}\n`);
  if (args.json) console.log(JSON.stringify(data, null, 2));
  else {
    for (const run of runs) {
      console.log(
        `${run.pods} pod(s): ${run.rps} req/s, worst p50 ${run.worstP50Ms} ms, worst p99 ${run.worstP99Ms} ms`,
      );
    }
  }
}
