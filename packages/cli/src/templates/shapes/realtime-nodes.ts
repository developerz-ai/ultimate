// `--shape realtime`'s proof that one change reaches two clients: the org's room on one in-process
// node (the `unit` step: who may join, what a member is sent), and the same room on TWO `sync`
// nodes over a real NATS bus (the `live` step, `TEST_NATS_URL` from docker/test-services.env).

import type { GeneratedFile, NameSet } from '../naming';

const SLICE = 'apps/web/app/post';

/**
 * A member's socket with no server behind it, recording every `events` frame: `WsLike` is
 * structural, so the hub writes to this exactly as it writes to a browser's WebSocket. Shared by
 * both suites, spelled once here and written into each — a `-fixture.ts` would count against the
 * app's coverage floor from a live suite that can never earn it.
 */
const memberRig = `/** A member's socket, recording the \`events\` frames the hub writes to it. */
const member = (name: string, orgId: string) => {
  const events: unknown[] = [];
  const first = Promise.withResolvers<void>();
  const ws: WsLike = {
    send: (data: string) => {
      const frame: unknown = JSON.parse(data);
      if (typeof frame === 'object' && frame !== null && Reflect.get(frame, 'type') === 'events') {
        events.push(Reflect.get(frame, 'event'));
        first.resolve();
      }
      return data.length;
    },
    close: () => undefined,
    subscribe: () => undefined,
    unsubscribe: () => undefined,
    getBufferedAmount: () => 0,
  };
  const actor = testActor(name, { orgId, permissions: ['post:read'] }).actor;
  const socket = new SyncSocket({ ws, clientBuildId: 'test', serverBuildId: 'test', actor });
  return { socket, events, received: first.promise };
};

/** The subscribe target a page sends for the org's room. */
const room = (orgId: string) =>
  ({ kind: 'channel', channel: postActivity.name, params: { orgId } }) as const;
`;

const unitSuite = (
  app: NameSet,
): string => `// postActivity on one node, in process: who may join the org's room, and what a member is sent
// when a post is created — through \`createPost\`, its enqueue and the notifier's run, never a
// publish by hand. The same room across two nodes and a real bus is ./channels.live.test.ts.
import { driver } from '@${app.kebab}/db';
import { testActor } from '@ultimat3/policy';
import type { WsLike } from '@ultimat3/realtime/server';
import {
  ChannelHub,
  InProcessTransport,
  SocketRegistry,
  SyncSocket,
} from '@ultimat3/realtime/server';
import { afterEach, expect, swapAdapter, unitTest } from '@ultimat3/testing';
import { createPost } from './actions/create-post';
import { postActivity } from './channels';
import { POST_CREATED } from './jobs/post-created';
import { recentPosts } from './queries/recent-posts';

const orgId = '00000000-0000-4000-8000-000000000002';
const otherOrg = '00000000-0000-4000-8000-000000000009';
const writer = testActor('writer', { orgId, permissions: ['post:write'] }).actor;

${memberRig}
/** One node: its bus is the one the notifier publishes on, as under \`x dev\`. */
const node = async () => {
  const transport = await swapAdapter('transport', new InProcessTransport());
  const sockets = new SocketRegistry();
  const hub = new ChannelHub({ transport, sockets });
  const join = async (joined: ReturnType<typeof member>, org: string) => {
    sockets.add(joined.socket);
    return hub.subscribeChannel(joined.socket, room(org));
  };
  return { hub, join };
};

afterEach(() => {
  driver.reset?.();
});

unitTest('the room re-reads through recentPosts, under the same rule', () => {
  expect(postActivity.events).toBe(true);
  expect(postActivity.params).toEqual(['orgId']);
  expect(recentPosts.policy).toBe(postActivity.policy);
});

unitTest('a member of another org is refused the room', async () => {
  const { hub, join } = await node();
  await expect(join(member('eve', otherOrg), orgId)).rejects.toThrow(/X_TOPIC_FORBIDDEN/);
  await hub.close();
});

unitTest('a created post reaches every member in the room, once', async ({ runJobs }) => {
  const { hub, join } = await node();
  const ada = member('ada', orgId);
  const bo = member('bo', orgId);
  await join(ada, orgId);
  await join(bo, orgId);
  const row = await createPost.named('createPost').as(writer, {
    title: 'hello',
    price: { minor: 0, currency: 'USD' },
  });
  await runJobs.drain();
  await Promise.all([ada.received, bo.received]);
  const sent = [{ type: POST_CREATED, id: row.id }];
  expect(ada.events).toEqual(sent);
  expect(bo.events).toEqual(sent);
  await hub.close();
});
`;

const liveSuite = (
  app: NameSet,
): string => `// postActivity across TWO \`sync\` nodes on one real NATS bus — the topology production runs once
// NATS_URL is set. Each node holds its own bus connection and its own sockets; a member joins the
// org's room on each; \`createPost\` runs, and its notifier publishes from a third connection, as a
// worker does. Both members are sent the one event: two clients, two nodes, one change.
//
// Skipped, naming the command that starts NATS, when TEST_NATS_URL is unset; \`bunx x verify\`
// starts docker/docker-compose.test.yml and sets it.
import { driver } from '@${app.kebab}/db';
import { testActor } from '@ultimat3/policy';
import type { WsLike } from '@ultimat3/realtime/server';
import { ChannelHub, NatsTransport, SocketRegistry, SyncSocket } from '@ultimat3/realtime/server';
import { afterEach, expect, liveTest, swapAdapter } from '@ultimat3/testing';
import { createPost } from './actions/create-post';
import { postActivity } from './channels';
import { POST_CREATED } from './jobs/post-created';

const orgId = '00000000-0000-4000-8000-000000000002';
const writer = testActor('writer', { orgId, permissions: ['post:write'] }).actor;
/** This suite's presence bucket on the shared test server, never the one an app runs on. */
const BUCKET = 'post_activity_test';

${memberRig}
/** One bus connection to the test server: a node's, or the worker's. */
const dial = async () => {
  const transport = new NatsTransport({ url: Bun.env.TEST_NATS_URL ?? '', bucket: BUCKET });
  await transport.connect();
  return transport;
};

/** A \`sync\` node of its own: bus connection, socket table, hub. */
const node = async () => {
  const transport = await dial();
  const sockets = new SocketRegistry();
  const hub = new ChannelHub({ transport, sockets });
  return {
    join: async (joined: ReturnType<typeof member>) => {
      sockets.add(joined.socket);
      return hub.subscribeChannel(joined.socket, room(orgId));
    },
    stop: async () => {
      await hub.close();
      await transport.close();
    },
  };
};

afterEach(() => {
  driver.reset?.();
});

liveTest(
  'a post created on one node reaches a member on each of two nodes',
  async ({ runJobs }) => {
    const a = await node();
    const b = await node();
    // The worker's bus: what the boot installs from NATS_URL in every role.
    const worker = await swapAdapter('transport', await dial());
    try {
      const ada = member('ada', orgId);
      const bo = member('bo', orgId);
      // Each subscribe resolves once that node's bridge to the bus is open: nothing is lost after.
      await a.join(ada);
      await b.join(bo);
      const row = await createPost.named('createPost').as(writer, {
        title: 'hello',
        price: { minor: 0, currency: 'USD' },
      });
      await runJobs.drain();
      await Promise.all([ada.received, bo.received]);
      const sent = [{ type: POST_CREATED, id: row.id }];
      expect(ada.events).toEqual(sent);
      expect(bo.events).toEqual(sent);
    } finally {
      await a.stop();
      await b.stop();
      await worker.close();
    }
  },
  { needs: ['nats'] },
);
`;

/** Both suites, beside the channel they prove. */
export const realtimeNodeFiles = (app: NameSet): readonly GeneratedFile[] => [
  { path: `${SLICE}/channels.test.ts`, contents: unitSuite(app) },
  { path: `${SLICE}/channels.live.test.ts`, contents: liveSuite(app) },
];
