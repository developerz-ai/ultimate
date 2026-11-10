// Tests only: replica A, as its own process — boots the cache hop on Redis with no NATS, busts one
// tag, prints the report's errors as one JSON line, and exits. `runtime-cache-redis.live.test.ts`
// is replica B. Argv: <redis url> <wire tag>.

import { declareTags, invalidateTags, noopPurgeDriver, parseTag } from '@ultimat3/cache';
import { InProcessTransport } from '@ultimat3/realtime/server';
import { startCacheTiers } from './runtime-cache';

const [url = '', wire = ''] = Bun.argv.slice(2);
const bust = parseTag(wire);
declareTags([bust.entity]);
const release = startCacheTiers({
  env: { REDIS_URL: url },
  purge: noopPurgeDriver(),
  transport: new InProcessTransport(),
  tiers: ['lru'],
});
const report = await invalidateTags([bust]);
await release();
console.log(JSON.stringify(report.errors));
process.exit(0);
