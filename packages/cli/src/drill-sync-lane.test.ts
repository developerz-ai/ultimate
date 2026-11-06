// The sync client dials the port the sync role binds — PORT + 1 — at the node's own path, and a
// fleet with no sync role gets no lane rather than a lane at nothing.

import { describe, expect, test } from 'bun:test';
import type { DrillFleet, DrillRoleProcess } from '@ultimat3/testing';
import { drillSyncLane, drillSyncUrl } from './drill-sync-lane';

const fleetWith = (
  roles: ReadonlyMap<'web' | 'worker' | 'sync', DrillRoleProcess>,
): DrillFleet => ({
  base: 'http://127.0.0.1:4000',
  databaseUrl: 'postgres://unused',
  proxies: new Map(),
  roles,
  stop: async () => undefined,
});

describe('drillSyncUrl', () => {
  test('PORT + 1, ws scheme, /_x/sync', () => {
    expect(drillSyncUrl('http://127.0.0.1:4100')).toBe('ws://127.0.0.1:4101/_x/sync');
  });
});

describe('drillSyncLane', () => {
  test('no sync role, no lane', () => {
    expect(drillSyncLane(fleetWith(new Map()))).toBeUndefined();
  });
});
