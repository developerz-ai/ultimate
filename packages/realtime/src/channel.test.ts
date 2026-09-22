import { afterAll, describe, expect, test } from 'bun:test';
import { type Actor, userActor } from '@ultimat3/core';
import { ChannelHub, type Topic } from './channel';
import { channel, topic } from './channel-decl';
import { clearChannels } from './channel-registry';
import { SubscriptionLimitError, TopicForbiddenError } from './errors';
import { InProcessTransport } from './fanout';
import { SocketRegistry, SyncSocket, type WsLike } from './socket';
import { decode, type Frame } from './sync-protocol';

const actor = (id: string): Actor => userActor({ id });

/** Membership lives in the app, not on the socket — the policy reads it off the actor's id. */
const membership = new Map<string, string>([
  ['alice', 'o1'],
  ['bob', 'o1'],
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

afterAll(() => {
  clearChannels();
});

/** `org.<orgId>.<leaf>`: one declared channel, open to the members of that org. */
const org = channel('org', {
  params: ['orgId', 'leaf'],
  catchUp: { name: 'orgRead' },
  events: true,
  policy: {
    kind: 'allow',
    label: 'org-member',
    permissions: [],
    children: [],
    run: ({ actor: who, input }) =>
      membership.get(who?.id ?? '') === (input as { orgId?: string }).orgId
        ? { allowed: true }
        : { allowed: false, reason: 'not a member', code: 'X_FORBIDDEN' },
  },
});

const cursors = (leaf = 'cursors', orgId = 'o1'): Topic => org.topic({ orgId, leaf });
const paramsOf = (name: Topic) => {
  const [, orgId = '', leaf = ''] = name.split('.');
  return { orgId, leaf };
};
const subscribe = (hub: ChannelHub, socket: SyncSocket, name: Topic): Promise<Topic> =>
  hub.subscribeChannel(socket, { kind: 'channel', channel: 'org', params: paramsOf(name) });
const publish = (hub: ChannelHub, name: Topic, event: { x: number; y: number }): Promise<void> =>
  hub.publishEvent(org, paramsOf(name), event);

describe('channels', () => {
  test('topic segments are validated, never escaped', () => {
    // `String(...)`, because `Topic` is a BRANDED string: the matcher is typed on what it
    // received, so a bare literal is not a `Topic` and the assertion could not be written.
    expect(String(cursors())).toBe('org.o1.cursors');
    expect(() => topic('org', 'o1.evil', 'cursors')).toThrow(TopicForbiddenError);
    expect(() => org.topic({ orgId: '>', leaf: 'cursors' })).toThrow(TopicForbiddenError);
  });

  test('a channel nobody declared is forbidden — authz holes are not a config option', async () => {
    const { hub, sockets } = harness();
    const { socket } = connect(sockets, actor('alice'));
    await expect(
      hub.subscribeChannel(socket, { kind: 'channel', channel: 'nobody', params: {} }),
    ).rejects.toThrow(TopicForbiddenError);
  });

  test('a published event reaches subscribers of that topic only', async () => {
    const { hub, sockets } = harness();
    const mine = connect(sockets, actor('alice'));
    const other = connect(sockets, actor('carol'));

    await subscribe(hub, mine.socket, cursors());
    await expect(subscribe(hub, other.socket, cursors())).rejects.toThrow(TopicForbiddenError);

    await publish(hub, cursors(), { x: 12, y: 40 });

    expect(mine.ws.frames).toHaveLength(1);
    const frame = mine.ws.frames[0];
    if (frame?.type !== 'events') return expect.unreachable('expected a channel events frame');
    expect(frame.event).toEqual({ x: 12, y: 40 });
    expect(other.ws.frames).toHaveLength(0);
  });

  test('an actor change re-checks every live subscription', async () => {
    const { hub, sockets } = harness();
    const { socket, ws } = connect(sockets, actor('alice'));
    const name = cursors();
    await subscribe(hub, socket, name);
    // The socket's own set and the registry's index, which are the two halves of one membership.
    // Bun's native topic set is deliberately not a third: nothing publishes to it.
    expect(socket.topics.has(name)).toBe(true);
    expect(hub.subscriberCount(name)).toBe(1);

    // The session changed: same socket, different actor, no longer a member of o1.
    inOrg('alice', 'o2');
    const dropped = await hub.onActorChange(socket, actor('alice'));
    inOrg('alice', 'o1');

    expect(dropped).toEqual([name]);
    expect(socket.topics.size).toBe(0);
    expect(hub.subscriberCount(name)).toBe(0);
    await publish(hub, name, { x: 1, y: 1 });
    expect(ws.frames).toHaveLength(0);
  });
});

/** A socket's topic set that records being asked — the scan this suite refuses is `has` calls. */
class CountingSet extends Set<string> {
  asked = 0;
  override has(value: string): boolean {
    this.asked += 1;
    return super.has(value);
  }
}

describe('what a channel costs the node', () => {
  test('delivery reads a per-topic index instead of scanning every socket', async () => {
    const { hub, sockets } = harness();
    const subscriber = connect(sockets, actor('alice'));
    const name = cursors();
    await subscribe(hub, subscriber.socket, name);
    // Sockets on this node that are not on this topic. Asked, one message with one legitimate
    // subscriber costs every socket the node holds — 50,000 of them at the repo's own benchmark
    // scale. The count is the assertion, not the clock: a scan is a scan at any size.
    const bystanders = Array.from({ length: 200 }, () => {
      const one = connect(sockets, actor('bob'));
      const counting = new CountingSet();
      Object.defineProperty(one.socket, 'topics', { value: counting });
      return counting;
    });

    for (let i = 0; i < 10; i += 1) await publish(hub, name, { x: i, y: i });

    expect(subscriber.ws.frames).toHaveLength(10);
    expect(bystanders.reduce((total, one) => total + one.asked, 0)).toBe(0);
  });

  test('a socket that closed stops being delivered to and leaves the index', async () => {
    const { hub, sockets } = harness();
    const name = cursors();
    const { socket, ws } = connect(sockets, actor('alice'));
    await subscribe(hub, socket, name);
    socket.close();
    await publish(hub, name, { x: 1, y: 1 });
    expect(ws.frames).toHaveLength(0);
    expect(hub.subscriberCount(name)).toBe(0);
  });

  test('unsubscribing removes only that socket from the topic', async () => {
    const { hub, sockets } = harness();
    const name = cursors();
    const stays = connect(sockets, actor('alice'));
    const goes = connect(sockets, actor('bob'));
    await subscribe(hub, stays.socket, name);
    await subscribe(hub, goes.socket, name);
    hub.unsubscribe(goes.socket, name);
    expect(hub.subscriberCount(name)).toBe(1);
    await publish(hub, name, { x: 1, y: 1 });
    expect(stays.ws.frames).toHaveLength(1);
    expect(goes.ws.frames).toHaveLength(0);
  });

  /**
   * The error's whole job is to name the setting an operator moves. Both hub caps are spelled in
   * `ChannelHubOptions` and neither is `maxPerSocket` — that is `LiveQueryRegistry`'s, one cap over
   * — so the per-socket topic refusal was handing out the wrong knob by falling through to the
   * default. Asserted against the option names themselves, so renaming either fails here.
   */
  test('each topic cap names its own option in the fix line', async () => {
    const transport = new InProcessTransport();
    const sockets = new SocketRegistry();
    const hub = new ChannelHub({ transport, sockets, maxTopicsPerSocket: 1, maxTopicsPerNode: 1 });
    const one = connect(sockets, actor('alice'));
    await subscribe(hub, one.socket, cursors('a'));

    const perSocket = await subscribe(hub, one.socket, cursors('b')).catch((e) => e);
    expect(perSocket).toBeInstanceOf(SubscriptionLimitError);
    expect((perSocket as SubscriptionLimitError).fix).toContain('maxTopicsPerSocket');

    const two = connect(sockets, actor('bob'));
    const perNode = await subscribe(hub, two.socket, cursors('c')).catch((e) => e);
    expect(perNode).toBeInstanceOf(SubscriptionLimitError);
    expect((perNode as SubscriptionLimitError).fix).toContain('maxTopicsPerNode');
  });

  test('distinct topics are capped per NODE, not only per socket', async () => {
    const transport = new InProcessTransport();
    const sockets = new SocketRegistry();
    const hub = new ChannelHub({ transport, sockets, maxTopicsPerNode: 2 });
    // Each distinct topic is one live transport subscription, and `topic()` admits any name
    // inside a tenant's own prefix — so a per-socket cap bounds nothing node-wide.
    const first = connect(sockets, actor('alice'));
    const second = connect(sockets, actor('bob'));
    await subscribe(hub, first.socket, cursors('a'));
    await subscribe(hub, second.socket, cursors('b'));
    await expect(subscribe(hub, first.socket, cursors('c'))).rejects.toThrow(
      SubscriptionLimitError,
    );
    // A topic that already exists is free: the cap bounds the bridge, not the subscriber.
    await expect(subscribe(hub, first.socket, cursors('b'))).resolves.toBe(cursors('b'));
    // And a released topic gives its slot back.
    hub.unsubscribe(first.socket, cursors('a'));
    hub.unsubscribe(second.socket, cursors('a'));
    await expect(subscribe(hub, first.socket, cursors('c'))).resolves.toBe(cursors('c'));
  });
});
