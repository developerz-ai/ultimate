// What a helm deploy tells the chart about the drain: `app.config.ts`'s `drain` section — the ONE
// drain budget since 25.0.0 deleted `http.drainTimeoutMs` — in the seconds `docker/helm` derives
// each role's terminationGracePeriodSeconds from. Passed on every upgrade, so a raised
// budget can never ship against a grace period sized for 25 s.

import type { DrainConfig } from '@ultimat3/core';
import { isUltimateError, READINESS_GRACE_DEFAULT_MS } from '@ultimat3/core';
import { loadDrainConfig } from './serve-drain';

const seconds = (ms: number): number => Math.ceil(ms / 1000);

/**
 * The `--set` pairs, or none when the app declares no budget (the chart's defaults are core's).
 * The chart's `drain.deadlineSeconds` is ONE budget for every role, and so is `drain.deadlineMs`:
 * the web role drains on it too. The margins stay the chart's.
 *
 * The grace is budgeted at no less than core's production default: the value read here is resolved
 * in THIS process's environment, and an `x deploy` run under `NODE_ENV=development` resolves the
 * grace to 0 while the pod it deploys runs with 5 s. Over-budgeting costs a pod nothing — it exits
 * when its drain does — and under-budgeting is a SIGKILL mid-drain.
 */
export function helmDrainOverrides(drain: Partial<DrainConfig> | undefined): readonly string[] {
  const out: string[] = [];
  if (drain?.deadlineMs !== undefined) {
    out.push('--set', `drain.deadlineSeconds=${seconds(drain.deadlineMs)}`);
  }
  if (drain === undefined) return out;
  const grace = Math.max(drain.readinessGraceMs ?? 0, READINESS_GRACE_DEFAULT_MS);
  out.push('--set', `drain.readinessGraceSeconds=${seconds(grace)}`);
  return out;
}

/**
 * The overrides for the app at `root`, off the one config loader. An `app.config.ts` the loader
 * refuses yields no drain section, and the chart's defaults stand: `X_CONFIG_INVALID`'s own fix for
 * a helm deploy is `--release <name>`, which must stay a way out, and the pods this upgrade starts
 * refuse the same config at boot — which `helm upgrade --wait` reports as the failed rollout it is.
 */
export async function readHelmDrainOverrides(root: string): Promise<readonly string[]> {
  let drain: Partial<DrainConfig> | undefined;
  try {
    drain = await loadDrainConfig(root);
  } catch (error) {
    if (!isUltimateError(error) || error.code !== 'X_CONFIG_INVALID') throw error;
    return [];
  }
  return helmDrainOverrides(drain);
}
