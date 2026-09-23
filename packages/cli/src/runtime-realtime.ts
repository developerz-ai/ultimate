// `realtime.enabled`, `realtime.transport` and `realtime.urlEnv`, read out of the app's own
// `app.config.ts` for the boot. The sibling of `runtime-notify-retention.ts` and `runtime-cache.ts`, and
// structural for their reason: `startServices` holds no `AppConfig`, and `defineConfig` returns a
// plain object. Until 22.0.0 no boot read any of the three and `NATS_URL` alone decided the bus.

// why: Bun ships no path-joining API — `Object.keys(Bun)` has `file`, `write`, `Glob`,
// `pathToFileURL` and `fileURLToPath`, and nothing that joins a path.
import { join } from 'node:path';
import { ConfigInvalidError, type RealtimeConfig, type RealtimeTransport } from '@ultimat3/core';
import { APP_CONFIG_EXPORT } from './app-auth';
import { APP_CONFIG_FILE } from './app-root';

/** Core's `defaults()` for the section, restated as the answer for a config that names none. */
export const REALTIME_DEFAULTS: RealtimeConfig = Object.freeze({
  enabled: true,
  transport: 'memory',
  urlEnv: undefined,
});

const TRANSPORTS: readonly RealtimeTransport[] = ['memory', 'nats'];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/** A transport this boot can build, or a refusal — never a guess at a bus. */
function transportOf(section: Record<string, unknown>): RealtimeTransport {
  const value = section['transport'];
  if (value === undefined) return REALTIME_DEFAULTS.transport;
  const known = TRANSPORTS.find((transport) => transport === value);
  if (known !== undefined) return known;
  throw new ConfigInvalidError({
    cause: `realtime.transport in ${APP_CONFIG_FILE} is not one of ${TRANSPORTS.join(', ')}`,
    fix: `set realtime: { transport: 'memory' } in ${APP_CONFIG_FILE}, or { transport: 'nats', urlEnv: 'NATS_URL' } for more than one node`,
    meta: { key: 'realtime.transport' },
  });
}

/**
 * The section as the boot obeys it. A key the file does not name keeps core's default, the same
 * per-key merge `defineConfig` performs, so the boot and the app's own config object agree.
 */
export async function loadRealtimeConfig(root: string): Promise<RealtimeConfig> {
  const path = join(root, APP_CONFIG_FILE);
  if (!(await Bun.file(path).exists())) return REALTIME_DEFAULTS;
  const module = (await import(path)) as Record<string, unknown>;
  const config = module[APP_CONFIG_EXPORT];
  const section = isRecord(config) ? config['realtime'] : undefined;
  if (!isRecord(section)) return REALTIME_DEFAULTS;
  const { enabled, urlEnv } = section;
  return {
    enabled: typeof enabled === 'boolean' ? enabled : REALTIME_DEFAULTS.enabled,
    transport: transportOf(section),
    urlEnv: typeof urlEnv === 'string' && urlEnv.trim() !== '' ? urlEnv.trim() : undefined,
  };
}
