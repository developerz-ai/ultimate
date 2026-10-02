// What the sync role hands its node from the app's own declarations: `APP_URL`'s origin (a page
// served on another origin than the node sees is admitted, any other is refused before
// `authenticate`), and `http.healthDetailPeers` (who the node's health paths tell the detail to).
import { afterEach, describe, expect, test } from 'bun:test';
import { configureHttp, resetHttpConfig } from '@ultimat3/http';
import { InProcessTransport } from '@ultimat3/realtime/server';
import type { StartRolesOptions } from './role-start';
import { prepareSync } from './role-sync';
import type { RunningServices } from './runtime-services';

const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
  resetHttpConfig();
});

const takes = { upgrade: () => true, requestIP: () => null };

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

describe('unit · prepareSync · health detail', () => {
  const prepare = async () => {
    const runtime = { transport: new InProcessTransport(), presenceTtlMs: 30_000 };
    const prepared = await prepareSync({
      roles: ['sync'],
      port: 0,
      buildId: 'build-1',
      runtime: runtime as unknown as RunningServices,
      routes: [],
      env: {},
      overrides: { syncAuthenticate: async () => null },
    } as StartRolesOptions);
    stops.push(() => prepared.stop());
    return async (address: string): Promise<boolean> => {
      const response = await prepared.node.fetch(new Request('http://sync.internal:3001/healthz'), {
        upgrade: () => true,
        requestIP: () => ({ address }),
      });
      return Object.hasOwn((await response?.json()) as object, 'buildId');
    };
  };

  test('with nothing declared, only the box itself is told the detail', async () => {
    const detailed = await prepare();
    expect(await detailed('127.0.0.1')).toBe(true);
    expect(await detailed('10.42.0.7')).toBe(false);
  });

  test("the app's http.healthDetailPeers reaches the sync node", async () => {
    configureHttp({ healthDetailPeers: ['private'] });
    const detailed = await prepare();
    expect(await detailed('10.42.0.7')).toBe(true);
    expect(await detailed('127.0.0.1')).toBe(false);
  });
});
