// Single responsibility: the boot's half of `publishChannelEvent` — the process bus, installed in
// every role and given back when the services stop. The `ChannelHub` is the `sync` role's, so
// before this install a job or an action reached none. Split from `runtime-services.test.ts` at
// the size ceiling.

import { afterAll, describe, expect, test } from 'bun:test';
// why: `node:` by necessity: Bun has no temp-directory, no mkdtemp and no recursive remove.
import { mkdtempSync, rmSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';
import { allow } from '@ultimat3/policy';
import { channel, clearChannels } from '@ultimat3/realtime';
import { publishChannelEvent } from '@ultimat3/realtime/server';
import { resolveServices } from './runtime-bindings';
import { startServices } from './runtime-services';

/** `x dev`'s environment — a table naming none is a production boot to the embedded disk. */
const DEV_ENV = { ULTIMATE_ENV: 'development' } as const;

const root = mkdtempSync(join(tmpdir(), 'x-dev-channel-bus-'));

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('startServices and the channel bus', () => {
  test(
    'the process bus is what publishChannelEvent publishes on, until stop()',
    async () => {
      const feed = channel('services-feed', {
        params: ['orgId'],
        catchUp: { name: 'servicesFeedRead' },
        events: true,
        policy: allow('public'),
      });
      const heard: string[] = [];
      const runtime = await startServices(resolveServices(root, {}), DEV_ENV);
      try {
        await runtime.transport.subscribe('x.channel.>', (_payload, subject) => {
          heard.push(subject);
        });
        await publishChannelEvent(feed, { orgId: 'o1' }, { kind: 'changed' });
        expect(heard).toEqual(['x.channel.services-feed.o1']);
      } finally {
        await runtime.stop();
        clearChannels();
      }
      // Released with the boot: a publish after it lands on a heap bus this one never was.
      await publishChannelEvent(feed, { orgId: 'o1' }, { kind: 'changed' });
      expect(heard).toHaveLength(1);
    },
    { timeout: 60_000 },
  );
});
