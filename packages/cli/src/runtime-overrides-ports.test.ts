// Every `RuntimeOverrides` port, swapped through `runtime.ts`, reaches the consumer that reads it —
// one memory fake per port, one real boot (embedded PGlite), the accessor each package answers
// with. Then the stop: a port left installed after its boot is the next command's wrong backend.

import { afterAll, describe, expect, test } from 'bun:test';
// why: `node:` by necessity: Bun has no temp-directory, no mkdtemp and no recursive remove.
import { mkdtempSync, rmSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import {
  getIdempotencyStore,
  getMeterStore,
  memoryIdempotencyStore,
  memoryMeterStore,
} from '@ultimat3/action';
import { memoryAuthServerStore } from '@ultimat3/auth';
import { installedAuthServerStore } from '@ultimat3/auth/adapter';
import { memoTier, noopPurgeDriver, registeredTiers } from '@ultimat3/cache';
import type { AuditSink, FailureStore } from '@ultimat3/core';
import {
  ambientClock,
  frozenClock,
  getAuditSink,
  installedErrorReporter,
  memoryErrorReporter,
} from '@ultimat3/core';
import { installedRateLimitStore, memoryRateLimitStore } from '@ultimat3/http';
import {
  eventBus,
  jobDriver,
  memoryEventBus,
  memoryJobDriver,
  memoryOutboxStore,
} from '@ultimat3/jobs';
import { mailDriver, memoryMailDriver } from '@ultimat3/mail';
import { memoryConfirmationStore } from '@ultimat3/mcp';
import { installedConfirmationStore } from '@ultimat3/mcp/adapter';
import { memoryInboxStore, notifyStores } from '@ultimat3/notify';
import { InProcessTransport } from '@ultimat3/realtime/server';
import { memoryStorageDriver } from '@ultimat3/storage';
import { resolveServices } from './runtime-bindings';
import type { RuntimeOverrides } from './runtime-overrides';
import { startServices } from './runtime-services';

const DEV_ENV = { ULTIMATE_ENV: 'development' } as const;
const root = mkdtempSync(join(tmpdir(), 'x-runtime-ports-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('each port swapped through runtime.ts reaches its consumer', () => {
  test(
    'installed while the boot runs, released when it stops',
    async () => {
      const audit: AuditSink = { write: () => undefined };
      const failure: FailureStore = { save: async () => undefined };
      const inbox = memoryInboxStore();
      const fakes = {
        jobs: memoryJobDriver(),
        eventBus: memoryEventBus(),
        outboxStore: memoryOutboxStore(),
        idempotencyStore: memoryIdempotencyStore(),
        meterStore: memoryMeterStore(),
        mail: memoryMailDriver(),
        rateLimitStore: memoryRateLimitStore(),
        notifyStores: { inbox },
        auditSink: audit,
        clock: frozenClock(1_760_000_000_000),
        failureStore: failure,
        transport: new InProcessTransport(),
        purge: noopPurgeDriver(),
        storage: memoryStorageDriver(),
        authServerStore: memoryAuthServerStore(),
        mcpConfirmationStore: memoryConfirmationStore(),
        errorReporter: memoryErrorReporter(),
        cacheTiers: [memoTier()],
      } satisfies RuntimeOverrides;

      const runtime = await startServices(resolveServices(root, {}), DEV_ENV, fakes);
      try {
        // The queue phase (`startQueue`).
        expect(jobDriver()).toBe(fakes.jobs);
        expect(eventBus()).toBe(fakes.eventBus);
        expect(getIdempotencyStore()).toBe(fakes.idempotencyStore);
        expect(getMeterStore()).toBe(fakes.meterStore);
        expect(runtime.outbox).toBe(fakes.outboxStore);
        // The boot phase, before `app.config.ts` evaluates.
        expect(ambientClock()).toBe(fakes.clock);
        // The services phase, before `loadApp`.
        expect(mailDriver()).toBe(fakes.mail);
        expect(installedRateLimitStore()).toBe(fakes.rateLimitStore);
        expect(notifyStores().inbox).toBe(inbox);
        // No ledger supplied: the boot's Postgres one, never notify's memory/refusing default.
        expect('purgeExpired' in notifyStores().ledger).toBe(true);
        expect(getAuditSink()).toBe(audit);
        expect(installedAuthServerStore()).toBe(fakes.authServerStore);
        expect(installedConfirmationStore()).toBe(fakes.mcpConfirmationStore);
        expect(installedErrorReporter()).toBe(fakes.errorReporter);
        // `cache.tiers` names the rungs (default `request-memo` + `lru`); a supplied tier replaces
        // the rung of its own name and the boot builds the rest.
        expect(registeredTiers().find((tier) => tier.name === 'request-memo')).toBe(
          fakes.cacheTiers[0],
        );
        // Read where they are used: the runtime carries the app's object, never a default.
        expect(runtime.transport).toBe(fakes.transport);
        expect(runtime.purge).toBe(fakes.purge);
        // The driver is the boot's default disk, registered under its own name.
        expect([runtime.storage.defaultDisk, runtime.storage.diskNames]).toEqual([
          'memory',
          ['memory'],
        ]);
        expect(runtime.failureStore).toBe(failure);
        expect(runtime.rateLimitStore).toBe(fakes.rateLimitStore);
      } finally {
        await runtime.stop();
      }
      // Every installed port back to its package default.
      expect(jobDriver()).toBeUndefined();
      expect(getIdempotencyStore()).not.toBe(fakes.idempotencyStore);
      expect(() => mailDriver()).toThrow(/X_MAIL_DRIVER_UNAVAILABLE/);
      expect(ambientClock()).not.toBe(fakes.clock);
      expect(getAuditSink()).not.toBe(audit);
      expect(installedAuthServerStore()).not.toBe(fakes.authServerStore);
      expect(installedConfirmationStore()).not.toBe(fakes.mcpConfirmationStore);
      expect(installedErrorReporter()).not.toBe(fakes.errorReporter);
      expect(registeredTiers()).toEqual([]);
    },
    { timeout: 60_000 },
  );
});
