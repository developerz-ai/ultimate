// The one `RunningServices` every `dev-roles` test file boots roles against, and the one reset
// between them. Shared rather than copied, for the reason `policy-fixture.ts` gives: three files
// start the same roles, and a second copy of the runtime drifts while each file keeps passing.
//
// Its own module rather than a `.test.ts` neighbours import, because `tsconfig.json` excludes
// `*.test.ts` — a fixture written there is one `tsc` never reads.

import { noopPurgeDriver } from '@ultimat3/cache';
import { resetLifecycle } from '@ultimat3/core';
import {
  createMemoryDriver,
  createMemoryEventBus,
  createMemoryOutboxStore,
  resetJobs,
  resetJobsFacade,
  resetTasks,
} from '@ultimat3/jobs';
import { createMemoryDriver as createMemoryMailDriver } from '@ultimat3/mail';
import { DEFAULT_PRESENCE_TTL_MS, InProcessTransport } from '@ultimat3/realtime/server';
import { defineStorage, localDriver } from '@ultimat3/storage';
import type { RunningServices } from './dev-runtime';
import { resolveServices } from './dev-services';

/**
 * Every service a role touches, embedded but real — no PGlite boot for a role-wiring test.
 *
 * `root` is a parameter and not a constant: each test file owns its own directory and deletes it,
 * so two files sharing one on-disk storage root cannot leave the other's fixture half-removed.
 */
export function fixtureRuntime(root: string): RunningServices {
  const services = resolveServices(root, {});
  const transport = new InProcessTransport();
  return {
    services,
    db: { async ping() {}, async close() {} } as unknown as RunningServices['db'],
    jobs: createMemoryDriver(),
    // A real store, not a stub: the `worker` role starts the outbox relay against it, and a relay
    // whose `claim()` rejects on the first 200ms tick is an unhandled rejection in whichever test
    // happens to still be running.
    outbox: createMemoryOutboxStore(),
    events: createMemoryEventBus(),
    transport,
    transportDetail: 'in-process fanout',
    // The sync role reads this to build its `PresenceRegistry`; the default is what a boot with no
    // `NATS_URL` resolves to, so the fixture is the real number rather than a rounder one.
    presenceTtlMs: DEFAULT_PRESENCE_TTL_MS,
    storage: defineStorage({ disks: { local: localDriver({ root: `${root}/storage` }) } }),
    mail: createMemoryMailDriver(),
    mailDetail: 'embedded',
    purge: noopPurgeDriver(),
    purgeDetail: 'none',
    stop: async () => transport.close(),
  };
}

/**
 * The process-global state one started role leaves behind. `resetLifecycle` is the load-bearing
 * one: core's lifecycle is process-wide and a stopped server leaves it drained, so without it the
 * SECOND web role in a file answers every request `X_DRAINING` — a suite that only passes when its
 * tests are run one at a time. `@ultimat3/http`'s own server suite resets it for the same reason.
 */
export function resetDevRolesState(): void {
  resetJobs();
  resetJobsFacade();
  resetTasks();
  resetLifecycle();
}
