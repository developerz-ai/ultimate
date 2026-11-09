/**
 * Postly's native apps: where their device registrations live, and the transport that reaches them.
 * One store, handed to both halves — `registerDevice` writes it and `nativePusher` reads it — the
 * way `@postly/mcp`'s confirmations hand one store to the decision action and the gate.
 *
 * The ids below are Postly's and not secret; the two private keys are, and are never options:
 * `nativePush()` reads `ULTIMATE_APNS_PRIVATE_KEY` / `ULTIMATE_FCM_PRIVATE_KEY` from the environment
 * (`x secrets set …`) when it mints a token, so a deploy without native apps never needs them.
 */

import { storeMode } from '@ultimat3/core';
import { dbExecutor } from '@ultimat3/db';
import {
  memoryPushDeviceStore,
  nativePush,
  type PushDeviceStore,
  postgresPushDeviceStore,
} from '@ultimat3/notify';

/**
 * `x_push_devices` (a framework table the boot applies) through `@ultimat3/db`'s one executor
 * builder, everywhere except `bun test` — core's `storeMode`, the rule `@postly/mcp` follows.
 */
export const pushDevices: PushDeviceStore =
  storeMode(Bun.env) === 'memory'
    ? memoryPushDeviceStore()
    : postgresPushDeviceStore({ executor: dbExecutor() });

/** Postly's iOS and Android apps. `sandbox` would be a development build's tokens. */
export const nativePusher = nativePush({
  devices: pushDevices,
  apns: { teamId: 'P0STLY0001', keyId: 'P0STLYKEY1', topic: 'dev.ultimate.postly' },
  fcm: { projectId: 'postly-demo', clientEmail: 'push@postly-demo.iam.gserviceaccount.com' },
});
