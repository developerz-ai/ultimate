import { describe, expect, test } from 'bun:test';
import { type Actor, userActor } from '@ultimat3/core';
import { ChannelHub, topic } from './channel';
import { TopicForbiddenError } from './errors';
import { InProcessTransport } from './fanout';
import { SocketRegistry, SyncSocket, type WsLike } from './socket';
import { decode, type Frame } from './sync-protocol';

const actor = (id: string): Actor => userActor({ id });

/** Membership lives in the app, not on the socket — the guard reads it, exactly like a policy. */
const membership = new Map<string, string>([
  ['alice', 'o1'],
  ['carol', 'o2'],
]);
const inOrg = (id: string, org: string): void => {
  membership.set(id, org);
};

class FakeWs implements WsLike {
  readonly frames: Frame[] = [];
  readonly topics = new Set<string>();
  send(data: string): number {
    this.frames.push(decode(data));
    return data.length;
  }
  close(): void {}
  subscribe(name: string): void {
    this.topics.add(name);
  }
  unsubscribe(name: string): void {
    this.topics.delete(name);
  }
  getBufferedAmount(): number {
    return 0;
  }
}

function harness(): { hub: ChannelHub; sockets: SocketRegistry; transport: InProcessTransport } {
  const transport = new InProcessTransport();
  const sockets = new SocketRegistry();
  const hub = new ChannelHub({ transport, sockets });
  return { hub, sockets, transport };
}

function connect(sockets: SocketRegistry, who: Actor): { socket: SyncSocket; ws: FakeWs } {
  const ws = new FakeWs();
  const socket = new SyncSocket({
    ws,
    clientBuildId: 'build-1',
    serverBuildId: 'build-1',
    actor: who,
  });
  sockets.add(socket);
  return { socket, ws };
}

describe('channels', () => {
  test('topic segments are validated, never escaped', () => {
    expect(topic('org', 'o1', 'cursors')).toBe('org.o1.cursors');
    expect(() => topic('org', 'o1.evil', 'cursors')).toThrow(TopicForbiddenError);
    expect(() => topic('org', '>', 'cursors')).toThrow(TopicForbiddenError);
  });

  test('a topic with no guard is forbidden — authz holes are not a config option', async () => {
    const { hub, sockets } = harness();
    const { socket } = connect(sockets, actor('alice'));
    await expect(hub.subscribe(socket, topic('org', 'o1', 'cursors'))).rejects.toThrow(
      TopicForbiddenError,
    );
  });

  test('a published message reaches subscribers of that topic only', async () => {
    const { hub, sockets } = harness();
    hub.guard(
      'org.*.cursors',
      ({ actor: who, segments }) => membership.get(who?.id ?? '') === segments[1],
    );
    const mine = connect(sockets, actor('alice'));
    const other = connect(sockets, actor('carol'));

    await hub.subscribe(mine.socket, topic('org', 'o1', 'cursors'));
    await expect(hub.subscribe(other.socket, topic('org', 'o1', 'cursors'))).rejects.toThrow(
      TopicForbiddenError,
    );

    await hub.publish(topic('org', 'o1', 'cursors'), { x: 12, y: 40 });

    expect(mine.ws.frames).toHaveLength(1);
    const frame = mine.ws.frames[0];
    if (frame?.type !== 'patch') throw new Error('expected a channel patch frame');
    expect(frame.patches[0]?.row).toEqual({ x: 12, y: 40 });
    expect(other.ws.frames).toHaveLength(0);
  });

  test('an actor change re-checks every live subscription', async () => {
    const { hub, sockets } = harness();
    hub.guard(
      'org.*.cursors',
      ({ actor: who, segments }) => membership.get(who?.id ?? '') === segments[1],
    );
    const { socket, ws } = connect(sockets, actor('alice'));
    const name = topic('org', 'o1', 'cursors');
    await hub.subscribe(socket, name);
    expect(ws.topics.has(name)).toBe(true);

    // The session changed: same socket, different actor, no longer a member of o1.
    inOrg('alice', 'o2');
    const dropped = await hub.onActorChange(socket, actor('alice'));

    expect(dropped).toEqual([name]);
    expect(socket.topics.size).toBe(0);
    expect(ws.topics.has(name)).toBe(false);
    await hub.publish(name, { x: 1, y: 1 });
    expect(ws.frames).toHaveLength(0);
  });
});
