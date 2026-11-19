// A test run's share of the machine: each batch of `bun test` workers reserves its measured memory
// in the machine ledger (`heavy-ledger.ts`) and takes the width the core cap and the ledger allow,
// so a second run on the same box narrows or queues instead of doubling its memory.

import type { WorkerLease } from './heavy';
import { leaseWorkers } from './heavy';
import type { HeavyEnv } from './heavy-env';
import { E2E_LANE_PEAK_MB, TEST_RUN_BASE_MB, TEST_WORKER_PEAK_MB } from './heavy-weights';

/** `0` turns the lease off for one run; the ledger's own switch is `ULTIMATE_HEAVY_MEMORY=0`. */
export const SLOTS_ENV = 'ULTIMATE_TEST_SLOTS';

export type MachineLease = (want: number) => Promise<WorkerLease>;

/** What a run of this suite reserves: a browser lane is one measured whole. */
export const suiteWeight = (
  type: string | undefined,
): { readonly unitMb: number; readonly baseMb: number } =>
  type === 'e2e'
    ? { unitMb: E2E_LANE_PEAK_MB, baseMb: 0 }
    : { unitMb: TEST_WORKER_PEAK_MB, baseMb: TEST_RUN_BASE_MB };

/** `exact` is an explicit `--workers`: that width, waited for, and no core cap. */
export const machineLease = (
  env: HeavyEnv,
  input: {
    readonly cwd: string;
    readonly label: string;
    readonly type?: string;
    readonly exact?: boolean;
  },
): MachineLease | undefined =>
  env[SLOTS_ENV] === '0'
    ? undefined
    : (want) =>
        leaseWorkers(want, {
          label: input.label,
          cwd: input.cwd,
          env,
          ...suiteWeight(input.type),
          ...(input.exact === true ? { exact: true } : {}),
        });
