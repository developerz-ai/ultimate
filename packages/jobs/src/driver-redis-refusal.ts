// An unreachable Redis, as the jobs contract says it: `X_DRIVER_UNAVAILABLE`, not Bun's client
// error. Core's `redisClient()` refuses every command at once while down, so an enqueue fails typed
// and immediately where `Bun.redis` blocked it, then closed the queue for good.

import { renderThrowable, stringField } from '@ultimat3/core';
import type { RedisSender } from './driver-redis';
import { DriverUnavailableError } from './errors';

/** Bun's code for a command refused for want of a connection: nothing reached the server. */
const CONNECTION_CLOSED = 'ERR_REDIS_CONNECTION_CLOSED';

/** `client` with its connection refusals typed. A server's own error reply passes through. */
export function typedRefusals(client: RedisSender): RedisSender {
  return {
    send: (command, args) =>
      client.send(command, args).catch((error: unknown) => {
        if (stringField(error, 'code') !== CONNECTION_CLOSED) throw error;
        throw new DriverUnavailableError({
          driver: 'redis',
          cause: `${command} was not sent, the connection is down (${renderThrowable(error)})`,
          fix: 'redis-cli -u "$REDIS_URL" PING — nothing was queued, so the same call is safe to repeat once it answers PONG; the client reconnects on its own',
        });
      }),
  };
}
