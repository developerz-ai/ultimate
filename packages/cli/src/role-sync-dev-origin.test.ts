// The whole boot, not the sync role alone: `startRoles` binds `web`, then hands its address to the
// node. `x dev --port N` beside an `.env` whose `APP_URL` names another port must still admit the
// page it serves; the same boot as a container must not.
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises'; // why: Bun has no recursive remove, only a per-file delete.
import { bindFreePorts } from '@ultimat3/testing';
import type { RunningRoles } from './role-start';
import { selectRoles, startRoles } from './role-start';
import { fixtureRuntime, resetDevRolesState } from './role-start-fixture';
import type { WebBinding } from './web-binding';

const ROOT = `${import.meta.dir}/../.roles-fixture-dev-origin`;

let running: RunningRoles | undefined;
afterEach(async () => {
  await running?.stop();
  running = undefined;
  resetDevRolesState();
});
afterAll(async () => {
  await rm(ROOT, { recursive: true, force: true });
});

/**
 * The boot binds `PORT` and its neighbour `PORT + 1` itself: a pair, so both were free when asked,
 * and one another process took before the boot bound it is the boot's `X_PORT_IN_USE`, asked again.
 */
async function boot(http: WebBinding): Promise<string> {
  running = await bindFreePorts(
    ([port = 0]) =>
      startRoles({
        roles: selectRoles('web,sync'),
        port,
        metricsPort: 0,
        buildId: 'test',
        runtime: fixtureRuntime(ROOT),
        // What both tracked apps and the scaffold ship in `.env.example`.
        env: { APP_URL: 'http://localhost:3000' },
        routes: [],
        http,
      }),
    { pair: true },
  );
  return running.url ?? expect.unreachable('the web role bound no port');
}

/** The page's own socket: the web port's mount, dialled with the page's `Origin`. */
function dial(app: string, origin: string): Promise<'open' | 'refused'> {
  return new Promise((resolve) => {
    const url = `${app.replace('http', 'ws')}/_x/sync?build=test`;
    const socket = new WebSocket(url, { headers: { origin } } as unknown as string[]);
    socket.onopen = () => {
      socket.close();
      resolve('open');
    };
    socket.onerror = () => resolve('refused');
    socket.onclose = () => resolve('refused');
  });
}

/** One real handshake on the web port as a tunnel delivers it: its own `Host`, a matching `Origin`. */
async function forwarded(app: string, host: string): Promise<number> {
  const response = await fetch(`${app}/_x/sync?build=test`, {
    headers: {
      host,
      origin: `https://${host}`,
      connection: 'Upgrade',
      upgrade: 'websocket',
      'sec-websocket-version': '13',
      'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
    },
  });
  await response.body?.cancel();
  return response.status;
}

const TUNNEL = 'dev-3000.preview.example.com';

describe('unit · startRoles · a forwarded host beside a declared APP_URL', () => {
  test('x dev admits the origin it was reached on: a Codespace, a tunnel', async () => {
    const app = await boot({ hostname: '127.0.0.1', dev: true });
    expect(await forwarded(app, TUNNEL)).toBe(101);
    // Still an exact match of host AND origin: a page elsewhere is refused through the tunnel too.
    expect(await dial(app, 'https://evil.example.com')).toBe('refused');
  });

  test('a container refuses the same request: the declaration is the whole list', async () => {
    const app = await boot({ hostname: '127.0.0.1', dev: false });
    expect(await forwarded(app, TUNNEL)).toBe(403);
  });
});

describe('unit · startRoles · the page origin on a port APP_URL does not name', () => {
  test('x dev admits the page it serves, and its 127.0.0.1 spelling', async () => {
    const app = await boot({ hostname: '127.0.0.1', dev: true });
    expect(new URL(app).port).not.toBe('3000');
    expect(await dial(app, app)).toBe('open');
    expect(await dial(app, `http://localhost:${new URL(app).port}`)).toBe('open');
    expect(await dial(app, 'http://localhost:3000')).toBe('open');
    expect(await dial(app, 'https://evil.example.com')).toBe('refused');
  });

  test('a container on the same boot refuses it: the declaration is the whole list', async () => {
    const app = await boot({ hostname: '127.0.0.1', dev: false });
    expect(await dial(app, app)).toBe('refused');
    expect(await dial(app, 'http://localhost:3000')).toBe('open');
  });
});
