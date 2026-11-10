// The error-groups suite over a reference memory store — `@ultimat3/admin`'s own stores are out of
// reach (same tier, no declared edge), so the reference proves the suite passes — and the proof it
// can fail: a store whose last-written occurrence moves `lastSeen`, older or not.

import { describe, expect, test } from 'bun:test';
import { finiteCount } from '@ultimat3/core';
import type {
  ErrorGroupLike,
  ErrorGroupOccurrenceLike,
  ErrorGroupsStoreLike,
} from './error-groups-store-conformance';
import {
  ERROR_GROUPS_STORE_CHECKS,
  errorGroupsStoreConformance,
} from './error-groups-store-conformance';
import { behavesLike } from './shared-examples';
import { testName } from './test-types';

/** The reference: one Map. `monotonic: false` is the defect, last write wins. */
function memoryStore(monotonic = true): ErrorGroupsStoreLike {
  const groups = new Map<string, ErrorGroupLike>();
  const fresh = (occurrence: ErrorGroupOccurrenceLike, at: string): ErrorGroupLike => ({
    fingerprint: occurrence.fingerprint,
    code: occurrence.code,
    status: 'open',
    firstSeen: at,
    lastSeen: at,
    count: occurrence.count,
    sample: occurrence.sample,
  });
  return {
    async record(occurrence) {
      const at = occurrence.at.toISOString();
      const seen = groups.get(occurrence.fingerprint);
      if (seen === undefined) {
        groups.set(occurrence.fingerprint, fresh(occurrence, at));
        return { isNew: true };
      }
      groups.set(occurrence.fingerprint, {
        ...seen,
        status: seen.status === 'resolved' ? 'open' : seen.status,
        lastSeen: monotonic && seen.lastSeen > at ? seen.lastSeen : at,
        count: seen.count + occurrence.count,
        sample: occurrence.sample,
      });
      return { isNew: false };
    },
    async list(query = {}) {
      const limit = finiteCount('memoryStore', 'limit', query.limit ?? 50, 1);
      return [...groups.values()]
        .filter((group) => query.status === undefined || group.status === query.status)
        .sort((a, b) => (a.lastSeen === b.lastSeen ? 0 : a.lastSeen < b.lastSeen ? 1 : -1))
        .slice(0, limit);
    },
    async get(fingerprint) {
      return groups.get(fingerprint);
    },
    async setStatus(fingerprint, status) {
      const seen = groups.get(fingerprint);
      if (seen === undefined) return undefined;
      const next = { ...seen, status };
      groups.set(fingerprint, next);
      return next;
    },
    async purge(beforeMs) {
      const before = new Date(beforeMs).toISOString();
      let removed = 0;
      for (const [fingerprint, group] of groups) {
        if (group.lastSeen >= before) continue;
        groups.delete(fingerprint);
        removed += 1;
      }
      return removed;
    },
  };
}

describe(testName('unit', 'a memory error-groups store'), () => {
  behavesLike(errorGroupsStoreConformance, () => memoryStore());
});

describe(
  testName('unit', 'an error-groups store that breaks the contract fails conformance'),
  () => {
    test('a late, older occurrence that moves last seen backwards', async () => {
      const late = ERROR_GROUPS_STORE_CHECKS.find((each) => each.name.startsWith('a late, older'));
      if (late === undefined)
        return expect.unreachable('no conformance check for a late occurrence');
      await expect(late.run(memoryStore(false), 'broken-')).rejects.toThrow();
      await late.run(memoryStore(), 'sound-');
    });

    test('every check has a name of its own', () => {
      const names = ERROR_GROUPS_STORE_CHECKS.map((each) => each.name);
      expect(new Set(names).size).toBe(names.length);
    });
  },
);
