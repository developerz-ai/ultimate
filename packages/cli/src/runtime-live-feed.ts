// Where a `sync` node's changes come from when this process boots one. Production decodes the
// write-ahead log (`x dev --role replicator`, `PgLogicalReplicationFeed`, a real `DATABASE_URL`).
// The embedded database has no walsender, and until 2026-09-05 nothing stood in for it: a live
// subscription under `x dev` took its snapshot and then heard nothing, so every `--live` query in
// every scaffolded app was dead in development — which is where an author first tries one.
//
// The bridge is `@ultimat3/realtime/server`'s `startLiveReplicator`, the same in-process row observer the
// framework's own live tests run on: a repository write in THIS process becomes a `ChangeEvent`
// shaped exactly as the WAL decoder shapes one, fanned into the node's registry. Its honest bound
// is stated there and repeated here — a write another process makes is invisible — and `x dev` is
// the one boot where that bound holds by construction: every role runs in this one process.

import { logger, renderThrowable } from '@ultimat3/core';
// `@ultimat3/realtime/server`, never `@ultimat3/testing`: this module is on the production boot
// path (`serve.ts` → `role-start.ts` → here), and the test harness was 38 modules of every image.
import {
  type LiveReplicator,
  RealtimeTopologyError,
  startLiveReplicator,
} from '@ultimat3/realtime/server';
import type { RunningSync } from './role-sync';
import type { ServiceMode } from './runtime-bindings';

/** What feeds the sync node, said out loud on the boot line and in `--json`. */
export type LiveFeed = 'in-process' | 'replication' | 'none';

export interface RunningLiveFeed {
  readonly feed: LiveFeed;
  /** The installed bridge, so a test can await `settled()`; `null` for the other two feeds. */
  readonly bridge: LiveReplicator | null;
  stop(): void;
}

export interface LiveFeedInput {
  /** The sync node this process booted, or `null` when the role was not selected. */
  readonly sync: RunningSync | null;
  /** The database's binding: `embedded` is PGlite, which has no log to decode. */
  readonly dbMode: ServiceMode;
  /** The bus this process fans out on (`Transport.name`): `in-process` reaches no other process. */
  readonly transport: string;
  /** Whether the `replicator` role runs in THIS process. */
  readonly replicatorHere: boolean;
}

/** The label the `x dev` boot line carries beside `db=`, `events=` and `storage=`. */
export const liveFeedLabel = (feed: LiveFeed): string => `live=${feed}`;

/**
 * `embedded` → the in-process bridge; anything else → replication, which is the WAL decoder's
 * job whether the replicator role runs in this process or another. Never both: with a real
 * database the decoder already delivers this process's own writes, and a bridge beside it would
 * deliver every one of them twice. No sync node, no feed to speak of.
 */
export async function startLiveFeed(input: LiveFeedInput): Promise<RunningLiveFeed> {
  if (input.sync === null) return { feed: 'none', bridge: null, stop: () => undefined };
  if (input.dbMode !== 'embedded') {
    // A decoder this node can hear: in this process, or on a bus other processes share. Neither
    // is a sync node that reported `replication` while nothing could ever reach it.
    if (input.transport === 'in-process' && !input.replicatorHere)
      throw new RealtimeTopologyError();
    return { feed: 'replication', bridge: null, stop: () => undefined };
  }
  const bridge = await startLiveReplicator({
    registry: input.sync.registry,
    // The same changes the channels read — a real node's change subscription feeds both.
    channels: input.sync.hub,
    // Logged, never thrown: one change nobody could fan out must not take the dev server down.
    onError: (error) =>
      logger.warn('live.bridge_delivery_failed', { error: renderThrowable(error) }),
  });
  logger.info('live feed in-process', {
    detail:
      'the embedded database has no walsender; repository writes in this process reach subscribers',
  });
  return { feed: 'in-process', bridge, stop: () => bridge.stop() };
}
