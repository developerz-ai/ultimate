#!/usr/bin/env bun
// Requests per second, p50, p99 and resident memory against ANY URL — this framework's scaffold or
// another stack's app — with a plain fetch client on Bun and no load-tool dependency. With
// `--start` it also boots the server and times the cold start to its first 2xx.
//
//   bun run scripts/bench/http-hello.ts --url http://localhost:3000/ [--seconds 30]
//     [--concurrency 16] [--runs 5] [--start '<command that serves the url>' [--cwd <dir>]]
//     [--out <file.json>] [--json]

// why: Bun exposes no total-memory or CPU-model primitive; `node:os` is the one portable reader.
import { cpus, totalmem } from 'node:os';
import { renderFixShellArg } from '@ultimat3/core';
import { parseScriptArgs } from '../lib/args';
import type { Finding } from '../lib/log';
import { report } from '../lib/log';
import { spreads } from './bench-spread';
import { type LoadResult, loadVerdict, runLoad } from './http-hello-load';

export const MIN_SECONDS = 10;
const START_TIMEOUT_MS = 60_000;

/** The machine a figure came from: a number with no box is a number nobody can compare. */
export const boxFacts = (env: Readonly<Record<string, string | undefined>>) => ({
  os: `${process.platform}-${process.arch}`,
  cpu: cpus()[0]?.model ?? 'unknown',
  cores: navigator.hardwareConcurrency,
  memoryGb: Math.round(totalmem() / 1024 ** 3),
  bun: Bun.version,
  // GitHub's runner image (`ubuntu-24.04`), or `local` — the runner type the plan asks printed.
  runner: env['ImageOS'] ?? env['RUNNER_NAME'] ?? 'local',
});

/** A whole number in [min, max], or a finding naming the flag. */
export function readCount(
  raw: string | boolean | undefined,
  fallback: number,
  bounds: { readonly flag: string; readonly min: number; readonly max: number },
): number | Finding {
  if (raw === undefined) return fallback;
  // A bare `--flag` parses as `true`, which `Number()` would read as 1: only a typed value counts.
  const value = typeof raw === 'string' ? Number(raw) : Number.NaN;
  if (Number.isInteger(value) && value >= bounds.min && value <= bounds.max) return value;
  return {
    code: 'X_CLI_BAD_FLAG',
    cause: `--${bounds.flag} must be a whole number from ${bounds.min} to ${bounds.max}`,
    fix: `bun run scripts/bench/http-hello.ts --url http://localhost:3000/ --${renderFixShellArg(bounds.flag, '<flag>')} ${renderFixShellArg(String(fallback), '<n>')}`,
  };
}

/** Below ten seconds a p99 is a handful of requests and a JIT warm-up: refused, never published. */
export const tooShort = (seconds: number, url: string): Finding | undefined =>
  seconds >= MIN_SECONDS
    ? undefined
    : {
        code: 'X_BENCH_RUN_TOO_SHORT',
        cause: `--seconds ${seconds} is under ${MIN_SECONDS}: a shorter run measures warm-up, not the server`,
        fix: `bun run scripts/bench/http-hello.ts --url ${renderFixShellArg(url, '<url>')} --seconds 30`,
      };

/** A run whose answers were not all 2xx, or that lost the server, is a finding, never a figure. */
export const failedRun = (result: LoadResult, url: string): Finding | undefined => {
  const reasons = loadVerdict(result);
  return reasons.length === 0
    ? undefined
    : {
        code: 'X_BENCH_RUN_FAILED',
        cause: `${url}: ${reasons.join('; ')}, so the run is not a figure`,
        fix: `curl -si ${renderFixShellArg(url, '<url>')}   # the URL must answer 2xx for the whole run`,
      };
};

/** The longest a booted app may live: far past a whole run, short of forever. */
const SERVER_DEADLINE_MS = 30 * 60_000;

const answerFetch = async (url: string) => {
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  return { status: response.status, bytes: (await response.arrayBuffer()).byteLength };
};

/**
 * Boot `command` in its own process group, then poll `url` until it answers 2xx: the cold start in
 * milliseconds. The group is what `stop` signals and what `rss` sums — `bun x x dev` is a tree.
 */
async function coldStart(command: string, url: string, cwd: string) {
  const started = performance.now();
  const child = Bun.spawn(['sh', '-c', command], {
    cwd,
    // `stop` ends it; this is for the run that never reaches `stop`. Three 30 s runs and a cold
    // start fit many times over, so a server alive past it is a bench that hung.
    timeout: SERVER_DEADLINE_MS,
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  const stop = (): void => {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      // The group is already gone: nothing left to stop.
    }
  };
  while (performance.now() - started < START_TIMEOUT_MS) {
    const ready = await answerFetch(url).then(
      (answer) => answer.status >= 200 && answer.status < 300,
      () => false,
    );
    if (ready)
      return { pgid: child.pid, stop, coldStartMs: Math.round(performance.now() - started) };
    if (child.exitCode !== null) break;
    await Bun.sleep(50);
  }
  stop();
  return { pgid: child.pid, stop, coldStartMs: null };
}

/** Resident memory of a process group in MiB, summed over its processes — `null` once it is gone. */
const rssMb = (pgid: number): number | null => {
  const out = Bun.spawnSync(['ps', '-o', 'rss=', '-g', String(pgid)], {
    timeout: 5_000,
  }).stdout.toString();
  const kib = out
    .split('\n')
    .map((line) => Number(line.trim()))
    .filter((value) => Number.isFinite(value) && value > 0);
  return kib.length === 0 ? null : Math.round(kib.reduce((sum, value) => sum + value, 0) / 1024);
};

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const url = args.flags.get('url');
  const fail: (findings: readonly Finding[]) => never = (findings) =>
    report({ ok: false, script: 'http-hello', summary: 'no figure', findings }, args.json);
  if (typeof url !== 'string') {
    fail([
      {
        code: 'X_BENCH_URL_REQUIRED',
        cause: '--url names no endpoint to load',
        fix: 'bun run scripts/bench/http-hello.ts --url http://localhost:3000/ --seconds 30',
      },
    ]);
  }
  const seconds = readCount(args.flags.get('seconds'), 30, { flag: 'seconds', min: 1, max: 3600 });
  const concurrency = readCount(args.flags.get('concurrency'), 16, {
    flag: 'concurrency',
    min: 1,
    max: 1024,
  });
  if (typeof seconds !== 'number') fail([seconds]);
  if (typeof concurrency !== 'number') fail([concurrency]);
  const short = tooShort(seconds, url);
  if (short !== undefined) fail([short]);

  const start = args.flags.get('start');
  const cwd = args.flags.get('cwd');
  const boot =
    typeof start === 'string'
      ? await coldStart(start, url, typeof cwd === 'string' ? cwd : process.cwd())
      : undefined;
  if (boot !== undefined && boot.coldStartMs === null) {
    fail([
      {
        code: 'X_BENCH_RUN_FAILED',
        cause: `${url} never answered 2xx within ${START_TIMEOUT_MS} ms of starting the --start command`,
        fix: `curl -si ${renderFixShellArg(url, '<url>')}   # with the --start command running by hand`,
      },
    ]);
  }
  const count = readCount(args.flags.get('runs'), 1, { flag: 'runs', min: 1, max: 20 });
  if (typeof count !== 'number') fail([count]);
  // Back to back against the one server: the spread is the server's, not five cold starts'.
  const results: LoadResult[] = [];
  for (let index = 0; index < count; index += 1) {
    const now = () => performance.now();
    results.push(
      await runLoad({ url, concurrency, durationMs: seconds * 1000, fetch: answerFetch, now }),
    );
  }
  const rss = boot === undefined ? null : rssMb(boot.pgid);
  boot?.stop();
  const spread = spreads(
    results.map((one) => ({ rps: one.rps, p50Ms: one.p50Ms, p99Ms: one.p99Ms })),
  );
  const data = {
    url,
    seconds,
    concurrency,
    box: boxFacts(Bun.env),
    coldStartMs: boot?.coldStartMs ?? null,
    rssMb: rss,
    spread,
    runs: results,
  };
  const out = args.flags.get('out');
  if (typeof out === 'string') await Bun.write(out, `${JSON.stringify(data, null, 2)}\n`);
  const failed = results.map((one) => failedRun(one, url)).find((finding) => finding !== undefined);
  report(
    {
      ok: failed === undefined,
      script: 'http-hello',
      summary: `${url}, ${count} run(s): median ${spread['rps']?.median} req/s, p50 ${spread['p50Ms']?.median} ms, p99 ${spread['p99Ms']?.median} ms`,
      findings: failed === undefined ? [] : [failed],
      data,
    },
    args.json,
  );
}
