// The load loop of `http-hello.ts`, pure over an injected fetch and clock: N workers request one URL
// until the deadline, and every answer is counted — a non-2xx and a refused connection are figures
// in the result, never a request quietly dropped from the denominator.

export type LoadFetch = (
  url: string,
) => Promise<{ readonly status: number; readonly bytes: number }>;

export interface LoadOptions {
  readonly url: string;
  readonly concurrency: number;
  readonly durationMs: number;
  readonly fetch: LoadFetch;
  /** Monotonic milliseconds. `performance.now` in a run, a counter in a test. */
  readonly now: () => number;
}

export interface LoadResult {
  readonly requests: number;
  readonly ok: number;
  readonly non2xx: number;
  /** A request that never got a status — the server refused, reset or died. */
  readonly errors: number;
  readonly statuses: Readonly<Record<string, number>>;
  readonly durationMs: number;
  readonly rps: number;
  readonly p50Ms: number;
  readonly p99Ms: number;
  readonly bytes: number;
}

/** The value at `fraction` of a sorted list, nearest rank; `0` for an empty one. */
export const percentile = (sorted: readonly number[], fraction: number): number => {
  if (sorted.length === 0) return 0;
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[rank] ?? 0;
};

const round = (value: number): number => Math.round(value * 100) / 100;

export async function runLoad(options: LoadOptions): Promise<LoadResult> {
  const started = options.now();
  const deadline = started + options.durationMs;
  const latencies: number[] = [];
  const statuses = new Map<number, number>();
  let errors = 0;
  let bytes = 0;

  const worker = async (): Promise<void> => {
    while (options.now() < deadline) {
      const sent = options.now();
      try {
        const answer = await options.fetch(options.url);
        latencies.push(options.now() - sent);
        statuses.set(answer.status, (statuses.get(answer.status) ?? 0) + 1);
        bytes += answer.bytes;
      } catch {
        // A refusal is a measured outcome, not a crash of the bench: counted, and the verdict
        // (`loadVerdict`) fails the run on it. The loop keeps its pace rather than spinning.
        errors += 1;
        latencies.push(options.now() - sent);
      }
    }
  };
  await Promise.all(Array.from({ length: options.concurrency }, worker));

  const elapsed = Math.max(options.now() - started, 1);
  const sorted = [...latencies].sort((a, b) => a - b);
  const ok = [...statuses].filter(([status]) => status >= 200 && status < 300);
  const okCount = ok.reduce((sum, [, count]) => sum + count, 0);
  const answered = [...statuses.values()].reduce((sum, count) => sum + count, 0);
  return {
    requests: answered + errors,
    ok: okCount,
    non2xx: answered - okCount,
    errors,
    statuses: Object.fromEntries([...statuses].map(([status, count]) => [String(status), count])),
    durationMs: round(elapsed),
    rps: round(((answered + errors) / elapsed) * 1000),
    p50Ms: round(percentile(sorted, 0.5)),
    p99Ms: round(percentile(sorted, 0.99)),
    bytes,
  };
}

/** Why a run is not a figure anyone may publish, or `[]` when it is. */
export const loadVerdict = (result: LoadResult): readonly string[] => [
  ...(result.requests === 0 ? ['no request completed'] : []),
  ...(result.non2xx > 0 ? [`${result.non2xx} answer(s) were not 2xx`] : []),
  ...(result.errors > 0
    ? [`${result.errors} request(s) got no answer — the server refused or died`]
    : []),
];
