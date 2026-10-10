// The PUBLISHING process of `channel-publish.live.test.ts`: what a worker is to a `sync` node — its
// own connection to the bus, no hub and no socket. Run as `bun <this file> <nats url> <org id>`;
// declares the same events-only channel, publishes one event on it and exits.

import { allow } from '@ultimat3/policy';
import { channel } from './channel-decl';
import { publishChannelEvent, setChannelTransport } from './channel-publish';
import { NatsTransport } from './nats-transport';

/** The declaration both processes make — a channel is code, loaded by every role. */
export const declareLiveFeed = () =>
  channel('livefeed', {
    params: ['orgId'],
    catchUp: { name: 'liveFeedRead' },
    events: true,
    policy: allow('public'),
  });

/** The bucket the bus's presence KV lives in for this suite; never the default a real app uses. */
export const LIVE_FEED_BUCKET = 'xlivefeed';

if (import.meta.main) {
  const [url = '', orgId = ''] = Bun.argv.slice(2);
  const transport = new NatsTransport({ url, bucket: LIVE_FEED_BUCKET });
  await transport.connect();
  // What `startServices` does in every role.
  setChannelTransport(transport);
  await publishChannelEvent(declareLiveFeed(), { orgId }, { kind: 'delivered', pid: process.pid });
  await transport.close();
}
