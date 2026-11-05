// How `coverage-gate.ts --all` spends one runner's cores: the workers a unit's `bun test` gets, what
// a unit weighs when shards are dealt, the env that keeps side-by-side units off one service, and
// the pool that never leases more cores than the runner has. Scheduling only — what a unit
// measures, and the verdict on it, are the gate's.

// why: Bun ships no synchronous file read; the env file is read once, before any unit starts.
import { readFileSync } from 'node:fs';
// why: Bun ships no path-join primitive.
import { join } from 'node:path';

/**
 * Test files one `bun test` worker is handed before a unit is widened by another. A unit at or
 * under it runs in ONE process, the command this gate always ran; past it, `--parallel`.
 *
 * 200, because a widened unit runs every file isolated (`testCommand`), and isolation re-imports
 * the module graph per file: measured 2026-11-05 on one box, `core` (184 files) went 17 s → 34 s
 * on three workers, `ai` 3.7 s → 8.4 s, `scraping` 1.9 s → 5.8 s. It pays only where one process
 * is the shard's whole wall clock: `cli`, 664 files, 430 s in one process on a runner (run
 * 42032367633), 1078 CPU-seconds and 233 s wall on four isolated workers here against 740 s in
 * one. Today that is `cli` (4 workers) and `scripts` (2).
 */
export const FILES_PER_WORKER = 200;

/** Workers for a unit of `testFiles` files on a runner of `jobs` cores: one per share, capped. */
export const workersFor = (testFiles: number, jobs: number): number =>
  Math.max(1, Math.min(jobs, Math.ceil(testFiles / FILES_PER_WORKER)));

/**
 * How many cores the gate leases out at once. Each unit is already its own `bun test` process —
 * the isolation this gate exists for — so running them side by side changes nothing a suite can
 * observe except the clock, and serially `--all` was 3m38s on a 12-core box that sat mostly idle.
 * Defaults to every core; `--jobs 1` is the serial run.
 */
export function concurrency(flag: string | undefined): number | undefined {
  if (flag === undefined) return Math.max(1, navigator.hardwareConcurrency);
  const n = Number(flag);
  return Number.isInteger(n) && n >= 1 ? n : undefined;
}

/**
 * Maps `items` through `run`, each holding `weightOf(item)` of `capacity` cores while it runs, and
 * answers in input order. The widest starts first — the long pole begun last is the whole wall
 * clock — and a narrow item takes the cores a wide one leaves free rather than waiting behind it.
 * A weight over `capacity` is clamped to it: it runs alone, never forever queued.
 */
export function leasePool<T, R>(
  items: readonly T[],
  capacity: number,
  weightOf: (item: T) => number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  const weight = items.map((item) => Math.max(1, Math.min(capacity, weightOf(item))));
  // Widest first; equal weights keep input order, so one tree schedules one way.
  const queue = items.map((_, index) => index).sort((a, b) => (weight[b] ?? 1) - (weight[a] ?? 1));
  let free = capacity;
  let running = 0;
  return new Promise<R[]>((resolve, reject) => {
    let failed = false;
    const fill = (): void => {
      if (failed) return;
      if (queue.length === 0 && running === 0) {
        resolve(out);
        return;
      }
      for (let at = 0; at < queue.length; ) {
        const index = queue[at] as number;
        const need = weight[index] ?? 1;
        if (need > free) {
          at += 1;
          continue;
        }
        queue.splice(at, 1);
        free -= need;
        running += 1;
        run(items[index] as T).then(
          (value) => {
            out[index] = value;
            free += need;
            running -= 1;
            fill();
          },
          (error: unknown) => {
            failed = true;
            reject(error);
          },
        );
      }
    };
    fill();
  });
}

/**
 * Core-seconds each unit cost — wall seconds × the workers it ran on, as the gate's `--json`
 * reports them — what `--shard` deals units by. Measured locally 2026-11-05, Bun 1.4.4, pinned to
 * four cores (`taskset -c 0-3`, a free runner's count) with no services, the CI job's condition;
 * the box was shared, so read each as ±30%. `cli` is 286 s on its four workers, `scripts` 77 s on
 * two. A drifted number only moves the balance, never a verdict; a unit missing weighs the median.
 * Refresh: `taskset -c 0-3 bun run scripts/coverage-gate.ts --all --json | jq -r '.data[] | "\(.pkg) \(.seconds * .workers)"'`.
 */
export const UNIT_SECONDS: Readonly<Record<string, number>> = {
  action: 47,
  admin: 36,
  ai: 5,
  auth: 47,
  cache: 5,
  cli: 1144,
  core: 12,
  'create-ultimate': 3,
  db: 96,
  entity: 78,
  flags: 1,
  http: 24,
  i18n: 1,
  jobs: 106,
  mail: 13,
  manifest: 2,
  mcp: 2,
  money: 1,
  notify: 1,
  policy: 1,
  pwa: 2,
  query: 2,
  realtime: 9,
  render: 10,
  schema: 1,
  scraping: 4,
  scripts: 154,
  seo: 1,
  storage: 7,
  testing: 64,
  time: 5,
  ui: 13,
};

/** What `name` weighs when shards are dealt: its measured core-seconds, or the median's. */
export function unitWeight(
  name: string,
  measured: Readonly<Record<string, number>> = UNIT_SECONDS,
): number {
  const known = measured[name];
  if (known !== undefined) return known;
  const sorted = Object.values(measured).sort((a, b) => a - b);
  return sorted.length === 0 ? 1 : (sorted[Math.floor(sorted.length / 2)] as number);
}

/** The service URLs `docker/test-services.env` declares, and the `DATABASE_URL` tests fall back to. */
export function serviceKeys(root: string): readonly string[] {
  const text = readFileSync(join(root, 'docker', 'test-services.env'), 'utf8');
  const keys = [...text.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((match) => match[1] as string);
  return [...keys, 'DATABASE_URL'];
}

/**
 * The env one unit's `bun test` runs in: this one, with every service URL taken away. Units run
 * side by side and a widened one runs as bun workers 1..n, so two units handed one
 * `TEST_DATABASE_URL` would each clone `ultimate_test_template_w1` and each drop the other's
 * (`packages/testing/src/template-db.ts`, `DROP DATABASE … WITH (FORCE)`). And the pins are
 * measured with no services (`coverage-pins.ts`): a laptop that sourced the env file reads the
 * runner's number, not one of its own.
 */
export function unitEnv(
  env: Readonly<Record<string, string | undefined>>,
  keys: readonly string[],
): Record<string, string> {
  const strip = new Set(keys);
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && !strip.has(key)) out[key] = value;
  }
  return out;
}
