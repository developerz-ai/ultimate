// The `subscribe` fixture's driver: one in-process `sync` node, one replicator, and a `LiveFeed`
// per subscriber built from the frames that subscriber actually received.
//
// Rows are never read out of the registry. They are accumulated from the `snapshot` and `patch`
// frames the node wrote to this socket, through `@ultimat3/realtime`'s own `applyPatches` — so what
// a test asserts is what a browser would hold, and a row the per-subscriber gate dropped is absent
// here for the same reason it would be absent there. A feed that reached into the window would
// prove the query works and say nothing about delivery, which is the half these tests are about.

import type { Actor } from '@ultimat3/core';
import { UltimateError } from '@ultimat3/core';
import type { LiveFeed, LiveFeedPatch, LiveTarget } from './fixture-drivers';
import type { LiveConnection, LiveNodeHandle } from './live-node';
import { createLiveNode } from './live-node';
import type { LiveReplicator } from './live-replicator';
import { startLiveReplicator } from './live-replicator';

interface Row {
  readonly id: string;
  readonly [column: string]: unknown;
}

interface SnapshotFrameLike {
  readonly type: 'snapshot';
  readonly sid: string;
  readonly rows: readonly Row[];
  readonly cursor: { readonly epoch: string; readonly version: number };
}

interface PatchFrameLike {
  readonly type: 'patch';
  readonly sid: string;
  readonly patches: readonly {
    readonly op: 'insert' | 'update' | 'delete';
    readonly id: string;
    readonly row: Record<string, unknown> | null;
    readonly lsn: string;
  }[];
  readonly lsn: string;
}

export interface SubscribeDriver {
  /** What `defineFixtures({ subscribe })` registers. */
  subscribe<R extends object>(
    target: LiveTarget,
    input: Readonly<Record<string, unknown>>,
    actor?: Actor | null,
  ): Promise<LiveFeed<R>>;
  readonly node: LiveNodeHandle;
  readonly replicator: LiveReplicator;
  stop(): Promise<void>;
}

/**
 * One node and one replicator per FIXTURE, which is one per test: a node shared across tests would
 * carry the previous test's subscriptions, and the row observer is process-global so two live at
 * once would each see the other's writes. `bun test` builds a fixture on first use and disposes it
 * with the test, which is exactly the lifetime this needs.
 */
export async function createSubscribeDriver(): Promise<SubscribeDriver> {
  const realtime = await import('@ultimat3/realtime');
  const node = await createLiveNode();
  const replicator = await startLiveReplicator({ registry: node.registry });
  const connections: LiveConnection[] = [];
  let sid = 0;

  const subscribe = async <R extends object>(
    target: LiveTarget,
    input: Readonly<Record<string, unknown>>,
    actor: Actor | null = null,
  ): Promise<LiveFeed<R>> => {
    const connection = await node.connect(actor);
    connections.push(connection);
    sid += 1;
    const id = `s${String(sid)}`;

    connection.send({
      type: 'hello',
      v: realtime.PROTOCOL_VERSION,
      buildId: 'test-build',
      sessionId: null,
      actorId: actor?.id ?? null,
    });
    await connection.settled();

    connection.send({
      type: 'subscribe',
      v: realtime.PROTOCOL_VERSION,
      op: 'add',
      sid: id,
      target: { name: target.name, input },
    });
    await connection.settled();

    const mine = (): readonly Record<string, unknown>[] =>
      connection.frames().filter((frame) => frame['sid'] === id);

    // A refusal arrives as an `ack` carrying an error, never as a thrown call — the socket stayed
    // up and the node answered. A test asserting `X_FORBIDDEN` wants the error, so it is rethrown
    // here rather than left for `feed.rows()` to report as an empty result.
    const refusal = connection
      .frames()
      .find((frame) => frame['type'] === 'ack' && frame['ref'] === id && frame['error'] != null);
    if (refusal !== undefined) {
      const wire = refusal['error'] as { code: string; cause: string; fix: string };
      throw new UltimateError({ code: wire.code, cause: wire.cause, fix: wire.fix });
    }

    const state = () => {
      let rows: readonly Row[] = [];
      let snapshots = 0;
      let lsn = '';
      let resumedFrom: string | undefined;
      const patches: LiveFeedPatch<R>[] = [];
      for (const frame of mine()) {
        if (frame['type'] === 'snapshot') {
          const snapshot = frame as unknown as SnapshotFrameLike;
          rows = snapshot.rows;
          snapshots += 1;
          continue;
        }
        if (frame['type'] !== 'patch') continue;
        const patch = frame as unknown as PatchFrameLike;
        // A patch arriving on a resubscribe rather than a snapshot IS the resume: the node answered
        // the cursor with a delta, which is what `planResume` decided and what test 5 asserts.
        if (snapshots === 1 && patches.length === 0 && lsn !== '') resumedFrom = lsn;
        rows = realtime.applyPatches(rows as never, patch.patches as never) as unknown as Row[];
        for (const one of patch.patches) {
          patches.push({ op: one.op, row: { id: one.id, ...(one.row ?? {}) } as unknown as R });
        }
        lsn = patch.lsn;
      }
      return { rows, snapshots, lsn, resumedFrom, patches };
    };

    return {
      rows: () => state().rows as unknown as readonly R[],
      row: (rowId: string) => state().rows.find((one) => one.id === rowId) as R | undefined,
      // No optimistic twin on this feed: `local()` is the client store's answer, and this driver
      // holds no store. A feed that returned the server row here would report the twin as applied
      // whether or not a mutator ever ran, which is the "reads as coverage" failure the fixture was
      // left unavailable to avoid. `useMutation` + `useMutationQueue` are the surface for that half.
      local: () => undefined,
      patches: () => state().patches,
      settled: async () => {
        await replicator.settled();
        await connection.settled();
      },
      lsn: () => state().lsn,
      resubscribedFrom: () => state().resumedFrom,
      snapshots: () => state().snapshots,
    };
  };

  return {
    subscribe,
    node,
    replicator,
    stop: async () => {
      replicator.stop();
      await node.stop();
    },
  };
}
