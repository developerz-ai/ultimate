// How many tracked apps `reference-app-gate.ts` builds and verifies side by side, and the one
// condition that puts the gates back in single file. Scheduling only: what a gate judges is the
// gate's, and the pool that answers in input order is `coverage-schedule.ts`'s `leasePool`.

/**
 * What one app's gate occupies while it runs: its own `x verify` parent, a `tsc`, biome, a static
 * build, Chrome for `e2e`. Its TEST workers are not counted here — they lease from the machine's
 * slot pool (`packages/cli/src/test-slots.ts`) whichever gate asks, so two gates side by side share
 * that budget rather than doubling it.
 */
export const CORES_PER_APP = 4;

/** The rest of that footprint in memory: the parent holds the app loaded, the build holds it again. */
export const BYTES_PER_APP = 8 * 1024 ** 3;

/**
 * `--jobs N`, or the default the machine affords: one app per `CORES_PER_APP` cores and per
 * `BYTES_PER_APP` of RAM, at least one. `undefined` is a value that does not parse — the caller
 * refuses it, because a typo read as "the default" is a run sized for a machine nobody described.
 */
export function appJobs(
  raw: string | boolean | undefined,
  cpus: number,
  totalBytes: number,
): number | undefined {
  if (raw !== undefined) {
    const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : Number.NaN;
    return Number.isInteger(n) && n >= 1 ? n : undefined;
  }
  const byCores = Math.floor(cpus / CORES_PER_APP);
  const byMemory = Math.floor(totalBytes / BYTES_PER_APP);
  return Math.max(1, Math.min(byCores, byMemory));
}

/**
 * The service URLs set in `env`, of `keys` (`coverage-schedule.ts`'s `serviceKeys`: every line of
 * `docker/test-services.env`, plus `DATABASE_URL`). Each names ONE server for every app: two
 * gates on one `TEST_DATABASE_URL` clone and `DROP … WITH (FORCE)` the same
 * `ultimate_test_template_w<N>` (`packages/testing/src/template-db.ts`), and a live suite's
 * replication slot is named per cluster, not per database.
 */
export const sharedServices = (
  env: Readonly<Record<string, string | undefined>>,
  keys: readonly string[],
): readonly string[] => keys.filter((key) => (env[key] ?? '') !== '');

/** How many GATES run at once: `jobs`, or one while any service is shared. Builds never share one. */
export const gateWidth = (jobs: number, shared: readonly string[]): number =>
  shared.length > 0 ? 1 : jobs;
