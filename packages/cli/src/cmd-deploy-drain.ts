// What a helm deploy tells the chart about the drain: `app.config.ts`'s `drain` section — and
// `configureHttp({ drainTimeoutMs })` where an app still declares it — in the seconds `docker/helm`
// derives each role's terminationGracePeriodSeconds from. Passed on every upgrade, so a raised
// budget can never ship against a grace period sized for 25 s.

import type { DrainConfig } from '@ultimat3/core';
import { isUltimateError, logger, READINESS_GRACE_DEFAULT_MS } from '@ultimat3/core';
import { configuredHttp } from '@ultimat3/http';
import { scanAppModules } from './app-load';
import { loadDrainConfig } from './serve-drain';

const seconds = (ms: number): number => Math.ceil(ms / 1000);

/**
 * The `--set` pairs, or none when the app declares neither budget (the chart's defaults are core's).
 *
 * The chart's `drain.deadlineSeconds` is ONE budget for every role, and `http.drainTimeoutMs`
 * REPLACES `drain.deadlineMs` on the web role at boot (`createServer` applies it after
 * `lifecycleForRole`). So the budget sent is the larger of the two: a web pod draining for its HTTP
 * timeout under a grace sized for the app budget is SIGKILLed mid-drain, while a worker given the
 * extra seconds only exits when its own drain does. The margins stay the chart's.
 *
 * The grace is budgeted at no less than core's production default: the value read here is resolved
 * in THIS process's environment, and an `x deploy` run under `NODE_ENV=development` resolves the
 * grace to 0 while the pod it deploys runs with 5 s. Over-budgeting costs a pod nothing — it exits
 * when its drain does — and under-budgeting is a SIGKILL mid-drain.
 */
export function helmDrainOverrides(
  drain: Partial<DrainConfig> | undefined,
  httpDrainTimeoutMs: number | undefined,
): readonly string[] {
  const budgets = [drain?.deadlineMs, httpDrainTimeoutMs].filter(
    (ms): ms is number => ms !== undefined,
  );
  const out: string[] = [];
  if (budgets.length > 0)
    out.push('--set', `drain.deadlineSeconds=${seconds(Math.max(...budgets))}`);
  if (drain === undefined) return out;
  const grace = Math.max(drain.readinessGraceMs ?? 0, READINESS_GRACE_DEFAULT_MS);
  out.push('--set', `drain.readinessGraceSeconds=${seconds(grace)}`);
  return out;
}

/**
 * `configureHttp({ drainTimeoutMs })`, as the web role will see it: the app's modules imported the
 * way its boot imports them, then the declaration read back. `undefined` when the app declares no
 * timeout (`null`, core's budget stands) or none at all. A module that would not import may be the
 * one holding the declaration, so it is said out loud rather than read as "none declared".
 */
async function readHttpDrainTimeoutMs(root: string): Promise<number | undefined> {
  const scan = await scanAppModules(root, { track: false });
  if (scan.findings.length > 0) {
    logger.warn('ultimate deploy app load incomplete', {
      findings: scan.findings.length,
      cause: `${scan.findings.length} app module(s) would not import, so a configureHttp({ drainTimeoutMs }) among them is not counted in the chart's grace period`,
      fix: 'x verify --json',
    });
  }
  const declared = configuredHttp()?.drainTimeoutMs;
  return typeof declared === 'number' ? declared : undefined;
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
  return helmDrainOverrides(drain, await readHttpDrainTimeoutMs(root));
}
