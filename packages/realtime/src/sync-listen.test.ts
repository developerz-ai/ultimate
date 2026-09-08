// Where this node's shutdown lands in the process lifecycle. Registered with no phase, the whole
// drain ran in `close` — the last phase — so between SIGTERM and it the node's `ready` flag was
// still true and `fetch` went on upgrading new websockets onto a process that was going away. That
// is exactly what the `accept` phase exists to prevent, and `@ultimat3/http`, the worker and the
// scheduler all register theirs there.

import { afterEach, describe, expect, test } from 'bun:test';
import {
  drain,
  onShutdown,
  resetLifecycle,
  resetListeners,
  shutdownHookCount,
} from '@ultimat3/core';
import type { SocketRegistry } from './socket';
import { listenSyncNode } from './sync-listen';
import type { SyncNode } from './sync-node';

/**
 * A node that records what was called, in order. The real one needs a bus, a hub and a registry to
 * say the same thing, and none of them is what this file is about — `node.websocket` is handed
 * straight to `Bun.serve`, so the fake has to satisfy it and nothing more.
 */
function fakeNode(log: string[]): SyncNode {
  return {
    sockets: undefined as unknown as SocketRegistry,
    ready: true,
    path: '/_x/sync',
    start: async () => undefined,
    stopAccepting: () => {
      log.push('stopAccepting');
    },
    stop: async () => {
      log.push('stop');
    },
    fetch: async () => new Response('not found', { status: 404 }),
    websocket: {
      idleTimeout: 120,
      backpressureLimit: 1024,
      maxPayloadLength: 1024,
      sendPings: false,
      open: () => undefined,
      message: () => undefined,
      close: () => undefined,
    },
    drain: async (options) => {
      log.push(options?.graceMs === undefined ? 'drain' : `drain(graceMs=${options.graceMs})`);
      return [];
    },
  };
}

afterEach(() => {
  resetLifecycle();
  resetListeners();
});

describe('listenSyncNode and the shutdown phases', () => {
  test('stops accepting in the accept phase, and drains after the in-flight wait', async () => {
    const log: string[] = [];
    const listener = listenSyncNode(fakeNode(log), { port: 0 });
    // The phase between the two. If `stopAccepting` runs before this and `drain` after it, the
    // node stopped taking new sockets the moment SIGTERM arrived and kept the ones it had for the
    // whole grace window — which is the shape every other role in this framework already has.
    onShutdown(
      'test:probe',
      () => {
        log.push('inflight');
      },
      { phase: 'inflight' },
    );

    await drain('SIGTERM');

    expect(log).toEqual(['stopAccepting', 'inflight', 'drain', 'stop']);
    listener.stop();
  });

  test('the drain grace it was given reaches drain(), and none means the node`s default', async () => {
    const log: string[] = [];
    const listener = listenSyncNode(fakeNode(log), { port: 0, drainGraceMs: 0 });
    try {
      await drain('SIGTERM');
      expect(log).toContain('drain(graceMs=0)');
    } finally {
      listener.stop();
    }
  });

  test('both hooks are unregistered by stop(), so a restart cannot drain a dead node', () => {
    const before = shutdownHookCount();
    const listener = listenSyncNode(fakeNode([]), { port: 0 });
    expect(shutdownHookCount()).toBe(before + 2);

    listener.stop();

    expect(shutdownHookCount()).toBe(before);
  });
});

describe('the interface it binds', () => {
  afterEach(() => {
    resetLifecycle();
    resetListeners();
  });

  test('binds the hostname it was given, and nothing wider', () => {
    // The bug: `x dev` binds its web role to `localhost` — the option's own docstring says "so a
    // laptop on a café network is not serving the app to the café" — while this listener took no
    // hostname at all and got Bun's `0.0.0.0`. The socket that carries `snapshot` and `patch`
    // frames for every registered live query was the one socket on every interface.
    const listener = listenSyncNode(fakeNode([]), { port: 0, hostname: '127.0.0.1' });
    expect(new URL(listener.url).hostname).toBe('127.0.0.1');
    listener.stop();
  });

  test('still defaults to every interface, which is what a container needs', () => {
    const listener = listenSyncNode(fakeNode([]), { port: 0 });
    expect(new URL(listener.url).hostname).not.toBe('127.0.0.1');
    listener.stop();
  });
});
