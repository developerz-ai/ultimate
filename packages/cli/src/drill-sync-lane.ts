// Where `x drill`'s sync client dials: the fleet's `sync` role binds its socket on PORT + 1
// (`syncPortFor`, the rule `role-sync.ts` listens by), at the node's `/_x/sync`. A fleet with no
// sync role has no lane, and `sync-resumes` is then red on no evidence.

import { PROTOCOL_VERSION } from '@ultimat3/realtime';
import type { DrillFleet, DrillSyncLane } from '@ultimat3/testing';
import { startDrillSync } from '@ultimat3/testing';
import { syncPortFor } from './flag-number';

/** The sync node's socket URL for a role handed `origin` as its PORT. */
export function drillSyncUrl(origin: string): string {
  const url = new URL(origin);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.port = String(syncPortFor(Number(url.port)));
  url.pathname = '/_x/sync';
  return url.href;
}

/** The lane `runDrill` starts with the fault, or none when the fleet runs no sync role. */
export function drillSyncLane(fleet: DrillFleet): (() => DrillSyncLane) | undefined {
  const sync = fleet.roles.get('sync');
  if (sync === undefined) return undefined;
  const url = drillSyncUrl(sync.origin);
  return () => startDrillSync({ url, protocolVersion: PROTOCOL_VERSION });
}
