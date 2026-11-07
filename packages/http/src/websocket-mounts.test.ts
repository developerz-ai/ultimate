// Joined mounts: an upgrade goes to the mount owning its path, and every later event of that socket
// goes back to the same mount — never to its neighbour — keyed by the data it upgraded with.

import { describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import type { UpgradeTarget, WebSocketMount } from './server';
import { joinWebSocketMounts } from './websocket-mounts';

interface Ws {
  readonly data: { readonly id: string };
}

function mount(path: string, seen: string[], limits: Partial<WebSocketMount['websocket']> = {}) {
  const declared: WebSocketMount<Ws> = {
    path,
    fetch: (request, server) =>
      server.upgrade(request, { data: { id: `${path}#1` } }) ? undefined : new Response('no'),
    websocket: {
      open: (ws) => void seen.push(`${path} open ${ws.data.id}`),
      message: (ws, message) => void seen.push(`${path} message ${ws.data.id} ${String(message)}`),
      close: (ws) => void seen.push(`${path} close ${ws.data.id}`),
      ...limits,
    },
  };
  return declared;
}

/** Bun's server as far as an upgrade goes: it keeps the data object, as `ws.data`. */
function server() {
  const sockets: { data: unknown }[] = [];
  const target: UpgradeTarget = {
    upgrade: (_request, options) => {
      sockets.push({ data: options.data });
      return true;
    },
    requestIP: () => null,
  };
  return { target, sockets };
}

describe('unit · joinWebSocketMounts', () => {
  test('an upgrade is routed by path and its events go back to that mount', async () => {
    const seen: string[] = [];
    const joined = joinWebSocketMounts([mount('/_x/sync', seen), mount('/link', seen)]);
    const { target, sockets } = server();
    expect([...joined.paths]).toEqual(['/_x/sync', '/link']);
    expect(await joined.fetch(new Request('http://a.test/link'), target)).toBeUndefined();
    expect(await joined.fetch(new Request('http://a.test/_x/sync?b=1'), target)).toBeUndefined();
    const [link, sync] = sockets;
    if (link === undefined || sync === undefined) return expect.unreachable('no socket');
    joined.websocket.open(link);
    joined.websocket.message(sync, 'hi');
    joined.websocket.close(link);
    expect(seen).toEqual([
      '/link open /link#1',
      '/_x/sync message /_x/sync#1 hi',
      '/link close /link#1',
    ]);
  });

  test('a path no mount owns is a 404, and a socket nobody upgraded reaches nobody', async () => {
    const seen: string[] = [];
    const joined = joinWebSocketMounts([mount('/link', seen)]);
    const answer = await joined.fetch(new Request('http://a.test/other'), server().target);
    expect(answer?.status).toBe(404);
    joined.websocket.open({ data: { id: 'stray' } });
    expect(seen).toEqual([]);
  });

  test("the listener's limits are the widest any mount declared", () => {
    const joined = joinWebSocketMounts([
      mount('/a', [], { maxPayloadLength: 1_024, idleTimeout: 30 }),
      mount('/b', [], { maxPayloadLength: 262_144, sendPings: true }),
    ]);
    expect(joined.websocket.maxPayloadLength).toBe(262_144);
    expect(joined.websocket.idleTimeout).toBe(30);
    expect(joined.websocket.sendPings).toBe(true);
    expect(joined.websocket.backpressureLimit).toBeUndefined();
  });

  test("Bun's drain reaches the mount that answers it, and only a socket that mount upgraded", async () => {
    const seen: string[] = [];
    const sync = mount('/_x/sync', seen);
    // The sync node's handler set carries `drain` — its backpressure gap repair — beside the three.
    const handlers = {
      ...sync.websocket,
      drain: (ws: Ws) => void seen.push(`drain ${ws.data.id}`),
    };
    const joined = joinWebSocketMounts([{ ...sync, websocket: handlers }, mount('/link', seen)]);
    const { target, sockets } = server();
    await joined.fetch(new Request('http://a.test/_x/sync'), target);
    await joined.fetch(new Request('http://a.test/link'), target);
    const [syncWs, link] = sockets;
    if (syncWs === undefined || link === undefined) return expect.unreachable('no socket');
    const { drain } = joined.websocket;
    if (drain === undefined) return expect.unreachable('the joined set dropped drain');
    drain(syncWs);
    drain(link);
    drain({ data: { id: 'stray' } });
    expect(seen).toEqual(['drain /_x/sync#1']);
  });

  test('a mount that declares no drain leaves the joined set without one', () => {
    expect(joinWebSocketMounts([mount('/a', []), mount('/b', [])]).websocket.drain).toBeUndefined();
  });

  test('two mounts at one path are refused', () => {
    try {
      joinWebSocketMounts([mount('/link', []), mount('/link', [])]);
    } catch (error) {
      expect(isUltimateError(error) ? error.code : 'not coded').toBe('X_INVARIANT');
      return;
    }
    expect.unreachable('two mounts at one path were joined');
  });
});
