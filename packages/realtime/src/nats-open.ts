// The production `NatsConnect`, as a door: the adapter and the `nats` library behind it — 65
// vendor modules — are imported when a client is OPENED, never when this package is. Every role
// of every app imports `@ultimat3/realtime/server`; only one configured for the NATS transport
// ever opens a client.

import type { NatsClient, NatsClientOptions } from './nats-client';

export const openNatsClient = async (options: NatsClientOptions): Promise<NatsClient> =>
  (await import('./nats-lib-client')).openNatsClient(options);
