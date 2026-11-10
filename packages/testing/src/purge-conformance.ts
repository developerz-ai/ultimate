// The `PurgeDriver` contract as shared examples: `behavesLike(purgeDriverConformance, () => ({
// driver, refused }))`. `driver` reaches a CDN that accepts every purge; `refused`, when the driver
// can be refused at all, the same driver against one that refuses — a purge that cleared nothing
// must never resolve as one that did, because no later read can tell.

import { expect, test } from 'bun:test';
import type { PurgeDriver } from '@ultimat3/cache';
import type { UltimateError } from '@ultimat3/core';
import { isUltimateError } from '@ultimat3/core';
import type { SharedExamples } from './shared-examples';
import { sharedExamples } from './shared-examples';

export interface PurgeSubject {
  readonly driver: PurgeDriver;
  /** Omitted by a driver no provider can refuse — `noopPurgeDriver`. */
  readonly refused?: PurgeDriver | undefined;
}

export interface PurgeCheck {
  readonly name: string;
  run(subject: PurgeSubject): Promise<void>;
}

/** Past Cloudflare's 30-tag and Fastly's 256-key request caps, so batching is part of the claim. */
const MANY = Array.from({ length: 300 }, (_, at) => `post:${at}`);

/** The coded error a call was refused with, or what happened instead, as a string to compare. */
async function refusalOf(call: () => Promise<unknown>): Promise<UltimateError | string> {
  try {
    await call();
  } catch (caught) {
    return isUltimateError(caught) ? caught : `not-a-coded-error: ${String(caught)}`;
  }
  return 'resolved';
}

export const PURGE_CHECKS: readonly PurgeCheck[] = [
  {
    name: 'a driver has a name, and an empty purge accepts nothing',
    async run({ driver }) {
      expect(driver.name).toMatch(/^\S+$/);
      expect(await driver.purge([])).toEqual([]);
    },
  },
  {
    name: 'a purge the provider takes whole reports every key, unchanged, across every batch',
    async run({ driver }) {
      const keys = ['post', 'post:1', 'feed', 'org:9f3b-1'];
      expect([...(await driver.purge(keys))].sort()).toEqual([...keys].sort());
      expect([...(await driver.purge(MANY))].sort()).toEqual([...MANY].sort());
    },
  },
  {
    name: 'purgeAll resolves when the provider takes it',
    async run({ driver }) {
      await expect(driver.purgeAll()).resolves.toBeUndefined();
    },
  },
  {
    name: 'a refused purge and a refused purgeAll are X_CACHE_PURGE_FAILED with a fix, never accepted',
    async run({ refused }) {
      if (refused === undefined) return;
      for (const call of [() => refused.purge(['post']), () => refused.purgeAll()]) {
        const refusal = await refusalOf(call);
        expect(typeof refusal === 'string' ? refusal : refusal.code).toBe('X_CACHE_PURGE_FAILED');
        expect(typeof refusal === 'string' ? '' : refusal.fix).not.toBe('');
      }
    },
  },
];

export const purgeDriverConformance: SharedExamples<PurgeSubject | Promise<PurgeSubject>> =
  sharedExamples('a CDN purge driver', (subject) => {
    for (const check of PURGE_CHECKS) {
      test(check.name, async () => {
        await check.run(await subject());
      });
    }
  });
