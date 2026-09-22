// `channel()` registers itself, so a hub built with no list serves every declared channel and the
// manifest reads the same table.

import { afterAll, describe, expect, test } from 'bun:test';
import { userActor } from '@ultimat3/core';
import { ChannelHub } from './channel';
import { channel } from './channel-decl';
import { describeChannels } from './channel-describe';
import { clearChannels, getChannel, registeredChannels } from './channel-registry';
import { InProcessTransport } from './fanout';
import { SocketRegistry, SyncSocket } from './socket';

afterAll(() => {
  clearChannels();
});

const zeta = channel('registry-zeta', { params: ['room'], catchUp: { name: 'zetaRead' } });
const alpha = channel('registry-alpha', {
  params: [],
  catchUp: { name: 'alphaRead' },
  events: true,
});

describe('the channel registry', () => {
  test('a declaration is registered by name, and only a Map lookup finds it', () => {
    expect(getChannel('registry-zeta')).toBe(zeta);
    expect(getChannel('constructor')).toBeUndefined();
  });

  test('registered and described in name order, a build input that diffs cleanly', () => {
    const names = registeredChannels().map((declared) => declared.name);
    expect(names.indexOf('registry-alpha')).toBeGreaterThanOrEqual(0);
    expect(names.indexOf('registry-alpha')).toBeLessThan(names.indexOf('registry-zeta'));
    expect(describeChannels().find((d) => d.name === 'registry-alpha')).toEqual({
      name: 'registry-alpha',
      params: [],
      catchUp: 'alphaRead',
      records: [],
      events: true,
      policy: null,
      permissions: [],
    });
    expect(alpha.events).toBe(true);
  });

  test('a hub given no list serves every registered channel', async () => {
    const sockets = new SocketRegistry();
    const hub = new ChannelHub({ transport: new InProcessTransport(), sockets });
    const socket = new SyncSocket({
      ws: {
        send: () => 1,
        close: () => {},
        subscribe: () => {},
        unsubscribe: () => {},
        getBufferedAmount: () => 0,
      },
      clientBuildId: 'b',
      serverBuildId: 'b',
      actor: userActor({ id: 'u' }),
    });
    sockets.add(socket);
    expect(
      String(
        await hub.subscribeChannel(socket, {
          kind: 'channel',
          channel: 'registry-zeta',
          params: { room: 'r1' },
        }),
      ),
    ).toBe('registry-zeta.r1');
  });
});
