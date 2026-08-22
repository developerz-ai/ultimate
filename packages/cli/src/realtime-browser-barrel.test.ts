// `@ultimat3/realtime` has two entries and the split is load-bearing, not cosmetic: the client one
// is bundled into a browser island. One barrel carrying `openNatsClient` beside `useLive` made that
// island unbuildable — `nats` require()s `stream/web` — with nothing but a reviewer's reading
// between the promise and the failure. This is the build error that replaces the reading.

import { describe, expect, test } from 'bun:test';

const FIXTURE = `${import.meta.dir}/realtime-browser-probe-fixture.ts`;

describe('@ultimat3/realtime browser barrel', () => {
  test('an island importing only useLive bundles for the browser', async () => {
    const built = await Bun.build({ entrypoints: [FIXTURE], target: 'browser', throw: false });
    const messages = built.logs.map((log) => log.message).join('\n');
    expect(messages).not.toContain('Node.js builtin');
    expect(built.success).toBe(true);
  });

  test('the client entry does not carry the bus', async () => {
    const client: Record<string, unknown> = await import('@ultimat3/realtime');
    expect(client['useLive']).toBeTypeOf('function');
    expect(client['openNatsClient']).toBeUndefined();
    expect(client['createSyncNode']).toBeUndefined();
  });

  test('the server entry carries it', async () => {
    const server: Record<string, unknown> = await import('@ultimat3/realtime/server');
    expect(server['openNatsClient']).toBeTypeOf('function');
    expect(server['createSyncNode']).toBeTypeOf('function');
  });
});
