// The request floor, in-process: what `pipeline.handle` costs a public `GET` answering `'ok'` and a
// 404, with no socket in the way (`http-hello.ts` is the over-the-wire tool and stays). Timed here
// for the result line only; `http-pipeline.bench.test.ts` holds the WORK COUNTS, which cannot flake.
//
//   bun run scripts/bench/http-pipeline.bench.ts [--json] [--requests=<n>] [--out=<file.json>]

import { installLogSink } from '../../packages/core/src/index';
import { defineHttpConfig } from '../../packages/http/src/config';
import type { ServerHooks } from '../../packages/http/src/hooks';
import { httpPipeline, type Pipeline } from '../../packages/http/src/pipeline';
import { rateLimiter } from '../../packages/http/src/rate-limit';
import { textResponse } from '../../packages/http/src/response';
import { httpRouter } from '../../packages/http/src/router';
import { parseScriptArgs } from '../lib/args';
import { report } from '../lib/log';
import { boxFacts, readCount } from './http-hello';

/** The two answers every app gives most: a trivial public page, and a miss. */
export const BENCH_CASES = ['hello', '404'] as const;
export type BenchCase = (typeof BENCH_CASES)[number];

const PATH: Readonly<Record<BenchCase, string>> = { hello: '/hello', '404': '/nope' };

/**
 * Callers come from many addresses and come back: a pool, cycled, rather than one address (a memo
 * would look free) or a fresh one per request (no real client mix is that).
 */
export const ADDRESS_POOL: readonly string[] = Array.from({ length: 64 }, (_, index) =>
  index % 2 === 0 ? `203.0.113.${index}` : `2001:db8:${index.toString(16)}::${index}`,
);

/**
 * The production shape: not dev, a process-scoped limiter whose bucket never refuses (a 429 is a
 * different request), one public route. Exported so the test counts work on exactly what is timed;
 * `explainMiss` lets it hand the 404 a throwable it can watch.
 */
export function benchPipeline(hooks: Pick<ServerHooks, 'explainMiss'> = {}): Pipeline {
  const config = defineHttpConfig({
    rateLimit: { scope: 'process' },
    dev: false,
    buildId: null,
    hostname: '127.0.0.1',
  });
  return httpPipeline({
    table: httpRouter([
      {
        method: 'GET',
        path: '/hello',
        meta: { name: 'hello', auth: 'public' },
        handler: () => textResponse('ok'),
      },
    ]),
    config,
    limiter: rateLimiter({
      config: {
        enabled: true,
        defaultBucket: 'default',
        tenantBucket: null,
        scope: 'process',
        buckets: { default: { capacity: 1e9, refillPerSecond: 1e9 } },
      },
    }),
    hooks,
  });
}

/** One request of a case, from the `index`-th pooled address; the body read, as a socket would. */
export async function answer(pipeline: Pipeline, which: BenchCase, index: number): Promise<number> {
  const response = await pipeline.handle(new Request(`http://localhost${PATH[which]}`), {
    role: 'web',
    ip: ADDRESS_POOL[index % ADDRESS_POOL.length] ?? null,
  });
  await response.arrayBuffer();
  return response.status;
}

export interface PipelineTiming {
  readonly case: BenchCase;
  readonly status: number;
  readonly usPerRequest: number;
}

async function usPer(pipeline: Pipeline, which: BenchCase, requests: number): Promise<number> {
  for (let index = 0; index < requests / 10; index += 1) await answer(pipeline, which, index);
  const started = Bun.nanoseconds();
  for (let index = 0; index < requests; index += 1) await answer(pipeline, which, index);
  return (Bun.nanoseconds() - started) / requests / 1_000;
}

/** Median of `rounds` timed loops per case: one loop on a shared box is one GC pause away. */
export async function benchPipelineCases(
  requests = 30_000,
  rounds = 5,
): Promise<readonly PipelineTiming[]> {
  const pipeline = benchPipeline();
  // The 404's `info` line is still BUILT — that is production's cost — and dropped instead of
  // written: a terminal or a pipe would time the reader, not the pipeline.
  const release = installLogSink(() => undefined);
  try {
    const results: PipelineTiming[] = [];
    for (const which of BENCH_CASES) {
      const runs: number[] = [];
      for (let round = 0; round < rounds; round += 1) {
        runs.push(await usPer(pipeline, which, requests));
      }
      runs.sort((a, b) => a - b);
      results.push({
        case: which,
        status: await answer(pipeline, which, 0),
        usPerRequest: Math.round((runs[Math.floor(rounds / 2)] ?? 0) * 10) / 10,
      });
    }
    return results;
  } finally {
    release();
  }
}

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const requests = readCount(args.flags.get('requests'), 30_000, {
    flag: 'requests',
    min: 1_000,
    max: 1_000_000,
  });
  if (typeof requests !== 'number') {
    report(
      {
        ok: false,
        script: 'http-pipeline.bench',
        summary: 'bad flag',
        findings: [
          { ...requests, fix: 'bun run scripts/bench/http-pipeline.bench.ts --requests=30000' },
        ],
      },
      args.json,
    );
  }
  const results = await benchPipelineCases(requests);
  const data = { box: boxFacts(Bun.env), requests, results };
  const out = args.flags.get('out');
  if (typeof out === 'string') await Bun.write(out, `${JSON.stringify(data, null, 2)}\n`);
  if (args.json) console.log(JSON.stringify(data, null, 2));
  else for (const r of results) console.log(`${r.case} (${r.status}): ${r.usPerRequest} µs`);
}
