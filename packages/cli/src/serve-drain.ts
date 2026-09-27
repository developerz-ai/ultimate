// `app.config.ts`'s `drain` and `health` sections, read for the production boot — the same import
// every other config reader here makes (`theme-boot.ts`, `app-auth.ts`), because the config is a
// module. Both shape what `/readyz` tells the load balancer.

import type { DrainConfig, HealthConfig } from '@ultimat3/core';
import { APP_CONFIG_EXPORT } from './app-auth';
import { APP_CONFIG_FILE } from './app-root';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/**
 * The declared section, or `undefined` when the app has none (a config not built by
 * `defineConfig`, or no config file): `@ultimat3/http` then keeps core's own default. A value that
 * is not a number is left for core to refuse, where the rule lives, rather than dropped here.
 */
export async function loadDrainConfig(root: string): Promise<Partial<DrainConfig> | undefined> {
  const path = `${root}/${APP_CONFIG_FILE}`;
  if (!(await Bun.file(path).exists())) return undefined;
  const module = (await import(path)) as Record<string, unknown>;
  const config = module[APP_CONFIG_EXPORT];
  const drain = isRecord(config) ? config['drain'] : undefined;
  if (!isRecord(drain) || !Object.hasOwn(drain, 'readinessGraceMs')) return undefined;
  return { readinessGraceMs: drain['readinessGraceMs'] as number };
}

/**
 * `health.readiness`, or `undefined` when the app declares none (core keeps `'dependencies'`). The
 * value is handed to `configureLifecycle` as written, so a bad one is refused by core's own rule.
 */
export async function loadHealthConfig(root: string): Promise<Partial<HealthConfig> | undefined> {
  const path = `${root}/${APP_CONFIG_FILE}`;
  if (!(await Bun.file(path).exists())) return undefined;
  const module = (await import(path)) as Record<string, unknown>;
  const config = module[APP_CONFIG_EXPORT];
  const health = isRecord(config)
    ? (config['health'] as Partial<HealthConfig> | undefined)
    : undefined;
  if (!isRecord(health) || health.readiness === undefined) return undefined;
  return { readiness: health.readiness };
}
