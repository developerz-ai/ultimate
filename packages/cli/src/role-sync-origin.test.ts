// The sync role hands the node `APP_URL`'s origin: a page served on another host than the node is
// admitted, and any other foreign page is refused before `authenticate` runs.
import { afterEach, describe, expect, test } from 'bun:test';
import { InProcessTransport } from '@ultimat3/realtime/server';
import type { StartRolesOptions } from './role-start';
import { prepareSync } from './role-sync';
import type { RunningServices } from './runtime-services';

const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
});

const takes = { upgrade: () => true };

describe('unit · prepareSync', () => {
  test('passes allowedOrigins from APP_URL to the node', async () => {
    // Only the two fields `prepareSync` reads off the runtime; the rest belongs to other roles.
    const runtime = { transport: new InProcessTransport(), presenceTtlMs: 30_000 };
    const prepared = await prepareSync({
      roles: ['sync'],
      port: 0,
      buildId: 'build-1',
      runtime: runtime as unknown as RunningServices,
      routes: [],
      env: { APP_URL: 'https://www.example.com' },
      overrides: { syncAuthenticate: async () => null },
    } as StartRolesOptions);
    stops.push(() => prepared.stop());
    const dial = (origin: string) =>
      prepared.node.fetch(
        new Request('https://sync.example.com/_x/sync', { headers: { origin } }),
        takes,
      );
    // Admitted past the origin check: the authenticator (which answers null) is what refuses it.
    expect((await dial('https://www.example.com'))?.status).toBe(401);
    expect((await dial('https://evil.example.com'))?.status).toBe(403);
  });
});
