// The `boot` ports (`runtime.ts`'s `clock`, `secretSource`), installed by ONE helper on every path
// that reads `runtime.ts` — after that module (and all it imports) has evaluated on the defaults,
// before `app.config.ts` and the app's modules do. `startServices` and every queue-only command
// (`x jobs`, `x auth`, `ROLE=migrate`) call it; a path that skipped it ran on the wrong key.

import { loadAppRuntime } from './app-runtime';
import type { DevServices, Env } from './runtime-bindings';
import { resolveServices } from './runtime-bindings';
import type { RuntimeOverrides } from './runtime-overrides';
import { BOOT_PORT_BINDINGS } from './runtime-port-bindings-queue';
import { installPorts, type PortRelease } from './runtime-ports';
import { type RunningQueue, type SchemaMode, startQueue } from './runtime-queue';

/** Install `runtime.ts`'s boot ports; answers the releases, in install order. */
export const installBootPorts = (overrides: RuntimeOverrides | undefined): Promise<PortRelease[]> =>
  installPorts(BOOT_PORT_BINDINGS, 'boot', {
    clock: overrides?.clock,
    secretSource: overrides?.secretSource,
  });

/** Newest first, every one, the first failure rethrown after the rest ran. */
async function releaseAll(releases: readonly PortRelease[]): Promise<void> {
  let first: { readonly error: unknown } | undefined;
  for (const release of [...releases].reverse()) {
    try {
      await release();
    } catch (error) {
      first ??= { error };
    }
  }
  if (first !== undefined) throw first.error;
}

/**
 * The queue with `runtime.ts` honoured whole: its boot ports first, then its queue ports
 * (`jobs`, `eventBus`, …) through `startQueue`. `stop()` releases the queue, then the boot ports.
 */
export async function startQueueWithBoot(
  services: DevServices,
  overrides: RuntimeOverrides | undefined,
  env: Env,
  schema?: SchemaMode,
): Promise<RunningQueue> {
  const booted = await installBootPorts(overrides);
  try {
    const queue = await startQueue(services, overrides, env, schema);
    return {
      ...queue,
      async stop() {
        try {
          await queue.stop();
        } finally {
          await releaseAll(booted);
        }
      },
    };
  } catch (error) {
    await releaseAll(booted).catch(() => undefined);
    throw error;
  }
}

/** A command's queue over the app at `root`: its `runtime.ts` read, then `startQueueWithBoot`. */
export async function openAppQueue(root: string, env: Env): Promise<RunningQueue> {
  return startQueueWithBoot(resolveServices(root, env), await loadAppRuntime(root), env);
}
