// `app.config.ts`'s `drain` and `health` sections for the production boot, off the one loader
// (`app-config-load.ts`). Both shape what `/readyz` tells the load balancer.

import type { DrainConfig, HealthConfig } from '@ultimat3/core';
import { loadAppConfig } from './app-config-load';

/** The declared section, or `undefined` for a root with no config file — core keeps its default. */
export async function loadDrainConfig(root: string): Promise<Partial<DrainConfig> | undefined> {
  const drain = (await loadAppConfig(root))?.drain;
  return drain === undefined
    ? undefined
    : { readinessGraceMs: drain.readinessGraceMs, deadlineMs: drain.deadlineMs };
}

/** `health.readiness`, or `undefined` for a root with no config file (core keeps its default). */
export async function loadHealthConfig(root: string): Promise<Partial<HealthConfig> | undefined> {
  const health = (await loadAppConfig(root))?.health;
  return health === undefined ? undefined : { readiness: health.readiness };
}
