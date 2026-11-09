// The `boot` and `queue` phases' rows of `PORT_BINDINGS`, alone: `startQueue` and the boot helper
// install exactly these, and they are on `ROLE=migrate`'s and `x jobs`' path — which must not load the AI, auth, mail, notify or scraping
// adapters the `services` rows import (`serve-graph.test.ts`'s `MIGRATE_CEILING`).

import { installIdempotencyStore, installMeterStore } from '@ultimat3/action/adapter';
import { installClock, installSecretSource } from '@ultimat3/core/adapter';
import { installEventBus, installJobDriver } from '@ultimat3/jobs/adapter';
import type { InstalledBinding } from './runtime-ports';

export interface QueuePortBindings {
  readonly eventBus: InstalledBinding<'eventBus'>;
  readonly idempotencyStore: InstalledBinding<'idempotencyStore'>;
  readonly jobs: InstalledBinding<'jobs'>;
  readonly meterStore: InstalledBinding<'meterStore'>;
}

export const QUEUE_PORT_BINDINGS: QueuePortBindings = {
  eventBus: { phase: 'queue', install: (bus) => installEventBus(bus) },
  idempotencyStore: { phase: 'queue', install: (store) => installIdempotencyStore(store) },
  jobs: { phase: 'queue', install: (driver) => installJobDriver(driver) },
  meterStore: { phase: 'queue', install: (store) => installMeterStore(store) },
};

export interface BootPortBindings {
  readonly clock: InstalledBinding<'clock'>;
  readonly secretSource: InstalledBinding<'secretSource'>;
}

/**
 * The `boot` phase's rows: installed before `app.config.ts` evaluates (its `installSecrets()` asks
 * the secret source), and by every command that opens the queue alone (`runtime-boot-ports.ts`).
 */
export const BOOT_PORT_BINDINGS: BootPortBindings = {
  clock: { phase: 'boot', install: (clock) => installClock(clock) },
  secretSource: { phase: 'boot', install: (source) => installSecretSource(source) },
};
