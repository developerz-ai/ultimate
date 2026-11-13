// `soak()`: many requests through one in-process handler, and the live heap after a full GC
// compared with the heap after the warm-up — the regression class (a cache with no bound, a
// listener per request) no point test sees until a pod is killed. The bound is the caller's
// MEASUREMENT: raise it with the measured figures and the reason, never to make it pass.

import { heapStats } from 'bun:jsc';
import { finiteCount, renderCauseValue, UltimateError } from '@ultimat3/core';

export interface SoakOptions {
  /** The app's request handler: `httpServer(...).fetch`, `BootedApp.fetch`, a pipeline's. */
  readonly fetch: (request: Request) => Response | Promise<Response>;
  /** One request per call, taken round-robin: a fresh `Request` every time, as a socket would. */
  readonly requests: readonly [() => Request, ...(() => Request)[]];
  /** Requests measured. Default 20,000. */
  readonly total?: number;
  /** Requests sent before the baseline, so lazy caches, JIT and pools are already full. Default 2,000. */
  readonly warmup?: number;
  /** Live-heap growth allowed across `total`, in bytes — a measurement, stated where it is passed. */
  readonly maxGrowthBytes: number;
}

export interface SoakReport {
  readonly requests: number;
  readonly baselineBytes: number;
  readonly finalBytes: number;
  readonly growthBytes: number;
  /** How many responses each status answered with: a soak that only ever 500s soaked nothing. */
  readonly statuses: ReadonlyMap<number, number>;
}

/** The heap grew past the stated bound: something holds a reference per request. */
export class SoakHeapGrowthError extends UltimateError {
  override readonly name = 'SoakHeapGrowthError';

  constructor(report: SoakReport, bound: number) {
    super({
      code: 'X_TEST_SOAK_HEAP_GROWTH',
      cause: `the live heap grew ${report.growthBytes} bytes over ${report.requests} requests (from ${report.baselineBytes} to ${report.finalBytes}), past the stated bound of ${bound}: something keeps a reference per request — a Map with no bound, a listener never removed, a closure held by a module-level array; statuses ${renderCauseValue([...report.statuses])}`,
      fix: "await Bun.write('soak-heap.json', JSON.stringify(Bun.generateHeapSnapshot()))   # after the soak: the type whose count is about the request count is the leak; raise maxGrowthBytes only with three measured runs written beside it",
      meta: { growthBytes: report.growthBytes, bound, requests: report.requests },
    });
  }
}

/** The live heap after two full collections: one frees, the second frees what finalizers let go. */
const liveHeap = (): number => {
  Bun.gc(true);
  Bun.gc(true);
  return heapStats().heapSize;
};

const send = async (
  options: SoakOptions,
  count: number,
  offset: number,
  statuses: Map<number, number>,
): Promise<void> => {
  for (let at = 0; at < count; at += 1) {
    const make = options.requests[(offset + at) % options.requests.length] ?? options.requests[0];
    const response = await options.fetch(make());
    // Drained: an unread body is a stream the handler's side still holds.
    await response.arrayBuffer();
    statuses.set(response.status, (statuses.get(response.status) ?? 0) + 1);
  }
};

/** Run the soak and report it, whatever the growth. `soak` is the verdict. */
export async function measureSoak(options: SoakOptions): Promise<SoakReport> {
  const total = finiteCount('soak()', 'total', options.total ?? 20_000, 1);
  const warmup = finiteCount('soak()', 'warmup', options.warmup ?? 2_000);
  await send(options, warmup, 0, new Map());
  const baselineBytes = liveHeap();
  const statuses = new Map<number, number>();
  await send(options, total, warmup, statuses);
  const finalBytes = liveHeap();
  return {
    requests: total,
    baselineBytes,
    finalBytes,
    growthBytes: finalBytes - baselineBytes,
    statuses,
  };
}

/** The soak, refused as `X_TEST_SOAK_HEAP_GROWTH` when the heap grew past `maxGrowthBytes`. */
export async function soak(options: SoakOptions): Promise<SoakReport> {
  const bound = finiteCount('soak()', 'maxGrowthBytes', options.maxGrowthBytes);
  const report = await measureSoak(options);
  if (report.growthBytes > bound) throw new SoakHeapGrowthError(report, bound);
  return report;
}
