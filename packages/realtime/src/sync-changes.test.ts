// The node's other subscription: the change bus. It is the one call site that fires the live
// registry with nothing awaiting it, so what is proven here is the wiring — a published change
// reaches `deliver` — and the failure, which nobody is awaiting and therefore nobody would see.

import { describe, expect, spyOn, test } from 'bun:test';
import { frozenClock, logger } from '@ultimat3/core';
import { RingChangeBuffer } from './change-buffer';
import type { ChangeEvent } from './changefeed';
import { formatLsn } from './changefeed';
import { ChannelHub } from './channel';
import { InProcessTransport } from './fanout';
import { LiveQueryRegistry } from './live-query';
import { CHANGE_SUBJECT_PREFIX } from './replicator';
import { SocketRegistry } from './socket';
import { createSyncNode, type SyncNode } from './sync-node';

const BUILD_ID = 'build-1';

const change: ChangeEvent = {
  entity: 'posts',
  op: 'update',
  before: null,
  after: { id: 'p1', orgId: 'o1', title: 'edited' },
  lsn: formatLsn(2),
  txid: '2',
  orgId: 'o1',
  at: 1_000,
};

function harness(registry: LiveQueryRegistry): {
  node: SyncNode;
  publish: (event: ChangeEvent) => Promise<void>;
} {
  const clock = frozenClock(0);
  const sockets = new SocketRegistry({ clock });
  const transport = new InProcessTransport({ clock });
  const node = createSyncNode({
    hub: new ChannelHub({ transport, sockets }),
    registry,
    transport,
    buildId: BUILD_ID,
    sockets,
    clock,
  });
  return {
    node,
    publish: async (event) => {
      await transport.publish(
        `${CHANGE_SUBJECT_PREFIX}.${event.entity}.${event.orgId}`,
        JSON.stringify(event),
      );
      // The handler is synchronous and the fanout is not; one turn is enough for an in-process bus.
      await Bun.sleep(1);
    },
  };
}

/** A registry whose fanout raises — a broken matcher, a full retained window, a dead gate. */
class FailingRegistry extends LiveQueryRegistry {
  override async deliver(): Promise<number> {
    throw new Error('fanout could not finish');
  }
}

/** A registry that only records, so the wiring can be checked without a subscription. */
class RecordingRegistry extends LiveQueryRegistry {
  readonly delivered: ChangeEvent[] = [];
  override async deliver(event: ChangeEvent): Promise<number> {
    this.delivered.push(event);
    return 0;
  }
}

describe('the change bus subscription', () => {
  test('a published change reaches the live registry', async () => {
    const registry = new RecordingRegistry({ source: new RingChangeBuffer() });
    const { node, publish } = harness(registry);
    await node.start();

    await publish(change);

    expect(registry.delivered.map((event) => event.lsn)).toEqual([formatLsn(2)]);
    await node.stop();
  });

  test('a fanout that fails is logged and reported, never left unhandled', async () => {
    const errors = spyOn(logger, 'error').mockImplementation(() => undefined);
    const { node, publish } = harness(new FailingRegistry({ source: new RingChangeBuffer() }));
    await node.start();

    // Nothing awaits this call. An unhandled rejection here is a fanout that reached nobody,
    // surfacing as a dead process — and on a runtime that only warns, as nothing at all.
    await publish(change);

    expect(errors).toHaveBeenCalledWith('live.deliver failed', {
      at: 'posts',
      error: 'fanout could not finish',
    });
    errors.mockRestore();
    await node.stop();
  });

  test('the subscription stops with the node', async () => {
    const registry = new RecordingRegistry({ source: new RingChangeBuffer() });
    const { node, publish } = harness(registry);
    await node.start();
    await node.stop();

    await publish(change);

    expect(registry.delivered).toEqual([]);
  });
});
