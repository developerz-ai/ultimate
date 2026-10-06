// A sync node's start against its stop and drain. `start()` awaits the change subscription, and a
// stop or drain that ran inside that await used to find nothing to release — the subscription
// landed after it, and the node came up `ready`, subscribed and delivering, after it was stopped.

import { describe, expect, test } from 'bun:test';
import { RingChangeBuffer } from './change-buffer';
import { ChannelHub } from './channel';
import type { Transport, TransportHandler, TransportSubscription } from './fanout';
import { InProcessTransport } from './fanout';
import { LiveQueryRegistry } from './live-query';
import { SocketRegistry } from './socket';
import { createSyncNode, type SyncNode } from './sync-node';

/** An in-process bus whose `subscribe` waits for `open()`, counting what is subscribed now. */
class GatedTransport implements Transport {
  readonly name = 'gated';
  readonly inner = new InProcessTransport();
  readonly shared = this.inner.shared;
  subscribes = 0;
  live = 0;
  #gate = Promise.withResolvers<void>();

  open(): void {
    this.#gate.resolve();
  }

  publish(subject: string, payload: string): Promise<void> {
    return this.inner.publish(subject, payload);
  }

  async subscribe(subject: string, handler: TransportHandler): Promise<TransportSubscription> {
    this.subscribes += 1;
    await this.#gate.promise;
    const subscription = await this.inner.subscribe(subject, handler);
    this.live += 1;
    return {
      subject,
      unsubscribe: () => {
        this.live -= 1;
        subscription.unsubscribe();
      },
    };
  }

  /** A bus with no connection to lose never calls the listener — the in-process one's answer. */
  onReconnect(): () => void {
    return this.inner.onReconnect();
  }

  close(): Promise<void> {
    return this.inner.close();
  }
}

function gatedNode(): { node: SyncNode; transport: GatedTransport } {
  const sockets = new SocketRegistry();
  const transport = new GatedTransport();
  const node = createSyncNode({
    hub: new ChannelHub({ transport, sockets }),
    registry: new LiveQueryRegistry({ source: new RingChangeBuffer() }),
    transport,
    buildId: 'build-1',
    sockets,
  });
  return { node, transport };
}

describe('a stop or drain that lands while start() is subscribing', () => {
  test('stop() waits the start out, and the node is left stopped and unsubscribed', async () => {
    const { node, transport } = gatedNode();
    const started = node.start();
    const stopped = node.stop();
    transport.open();
    await Promise.all([started, stopped]);
    expect({ ready: node.ready, live: transport.live }).toEqual({ ready: false, live: 0 });
  });

  test('a stop that does not wait still cannot be undone by the start it raced', async () => {
    const { node, transport } = gatedNode();
    const started = node.start();
    void node.stop();
    transport.open();
    await started;
    expect({ ready: node.ready, live: transport.live }).toEqual({ ready: false, live: 0 });
  });

  test('drain() racing a start leaves nothing subscribed either', async () => {
    const { node, transport } = gatedNode();
    const started = node.start();
    const drained = node.drain({ graceMs: 0 });
    transport.open();
    await Promise.all([started, drained]);
    expect({ ready: node.ready, live: transport.live }).toEqual({ ready: false, live: 0 });
  });

  test('two overlapping starts subscribe once, and a stopped node can start again', async () => {
    const { node, transport } = gatedNode();
    const first = node.start();
    const second = node.start();
    transport.open();
    await Promise.all([first, second]);
    expect({ ready: node.ready, subscribes: transport.subscribes, live: transport.live }).toEqual({
      ready: true,
      subscribes: 1,
      live: 1,
    });
    // A started node asked again is already started, not subscribed twice.
    await node.start();
    expect(transport.live).toBe(1);

    await node.stop();
    expect(transport.live).toBe(0);
    await node.start();
    expect({ ready: node.ready, live: transport.live }).toEqual({ ready: true, live: 1 });
    await node.stop();
  });
});
