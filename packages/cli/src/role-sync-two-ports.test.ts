// The sync role's origin rule on the wire: real listeners, real websocket handshakes carrying the
// page's `Origin`. The Compose rung (page and socket on two ports, `APP_URL` required), `x dev` on
// a port its `.env` does not name, and the combined-role container with `APP_URL` right and wrong.
import { afterEach, describe, expect, test } from 'bun:test';
import { InProcessTransport } from '@ultimat3/realtime/server';
import type { StartRolesOptions } from './role-start';
import { prepareSync } from './role-sync';
import type { RunningServices } from './runtime-services';
import type { WebBinding } from './web-binding';

const stops: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0).reverse()) await stop();
});

const page = (): Response => new Response('page');

/** A listener on a port of the kernel's choosing — the `web` role's stand-in, a real origin. */
function web(): { readonly port: number; readonly origin: string } {
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: page });
  stops.push(() => server.stop(true));
  const port = server.port ?? 0;
  return { port, origin: `http://127.0.0.1:${port}` };
}

interface Booted {
  /** The node's own listener, as a `ws://` url. */
  readonly url: string;
  /** The same node asked through the WEB port's mount, as `x dev` and a combined container do. */
  mounted(webOrigin: string, origin: string): Promise<Response | undefined>;
}

/**
 * The sync role with a real listener. `appUrl` is the web role's own address when one runs in the
 * process (the node then binds its neighbour); `null` is a `sync`-only container, kernel-assigned.
 */
async function sync(
  env: Record<string, string>,
  http: WebBinding,
  appUrl: string | null = null,
): Promise<Booted> {
  const prepared = await prepareSync({
    roles: ['sync'],
    port: 0,
    buildId: 'build-1',
    runtime: {
      transport: new InProcessTransport(),
      presenceTtlMs: 30_000,
    } as unknown as RunningServices,
    routes: [],
    env,
    http,
  } as StartRolesOptions);
  const running = await prepared.listen(appUrl);
  stops.push(() => running.stop());
  return {
    url: `${running.url.replace(/^http/, 'ws')}${prepared.node.path}`,
    mounted: async (webOrigin, origin) =>
      await prepared.node.fetch(
        new Request(`${webOrigin}${prepared.node.path}`, { headers: { origin } }),
        { upgrade: () => true, requestIP: () => null },
      ),
  };
}

const DEV: WebBinding = { hostname: '127.0.0.1', dev: true };
const CONTAINER: WebBinding = { hostname: '127.0.0.1', dev: false };

/** One real handshake from `origin`: the socket opened, or the refusal the node answered with. */
async function handshake(url: string, origin: string): Promise<'open' | Response> {
  const response = await fetch(url.replace(/^ws/, 'http'), {
    headers: {
      origin,
      connection: 'Upgrade',
      upgrade: 'websocket',
      'sec-websocket-version': '13',
      'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
    },
  });
  if (response.status !== 101) return response;
  await response.body?.cancel();
  return 'open';
}

const statusOf = async (url: string, origin: string): Promise<'open' | number> => {
  const answer = await handshake(url, origin);
  if (answer === 'open') return answer;
  await answer.body?.cancel();
  return answer.status;
};

/** And the same question asked by a real client, which is what a browser's socket is. */
function dial(url: string, origin: string): Promise<'open' | 'refused'> {
  return new Promise((resolve) => {
    const socket = new WebSocket(url, { headers: { origin } } as unknown as string[]);
    socket.onopen = () => {
      socket.close();
      resolve('open');
    };
    socket.onerror = () => resolve('refused');
    socket.onclose = () => resolve('refused');
  });
}

describe('unit · web and sync on two ports, real listeners', () => {
  test('with APP_URL naming the page origin, the page’s socket is admitted', async () => {
    const pages = web();
    const { url } = await sync({ APP_URL: pages.origin }, CONTAINER);
    expect(await dial(url, pages.origin)).toBe('open');
    // …and only that origin: another listener on the same machine is still refused.
    expect(await statusOf(url, `http://127.0.0.1:${pages.port + 7}`)).toBe(403);
  });

  test('without it the same socket is refused 403: the page and the node are two origins', async () => {
    const pages = web();
    const { url } = await sync({}, CONTAINER);
    expect(await statusOf(url, pages.origin)).toBe(403);
    expect(await dial(url, pages.origin)).toBe('refused');
    // The node's own origin is still admitted — a proxy serving both on one port needs nothing.
    expect(await dial(url, new URL(url.replace(/^ws/, 'http')).origin)).toBe('open');
  });
});

// Both tracked apps and the scaffold ship `APP_URL=http://localhost:3000` in `.env.example`, and a
// declared origin is the WHOLE list. `x dev --port 4000`, or dev opened as `127.0.0.1`, is then a
// page on an origin the declaration does not name — and every live island on it was refused.
describe('unit · x dev on another port than its APP_URL names', () => {
  const declared = { APP_URL: 'http://localhost:3000' };

  test('the page the dev server itself serves is admitted, under each loopback spelling', async () => {
    const pages = web();
    const node = await sync(declared, DEV, pages.origin);
    expect(new URL(node.url).port).not.toBe(String(pages.port));
    for (const host of ['127.0.0.1', 'localhost', '[::1]']) {
      const origin = `http://${host}:${pages.port}`;
      // The node's own listener, by a real client…
      expect(await dial(node.url, origin)).toBe('open');
      // …and the door a dev page really uses: the mount on the web port, reached as that host.
      expect(await node.mounted(origin, origin)).toBeUndefined();
    }
    // The declaration still stands beside it.
    expect(await statusOf(node.url, 'http://localhost:3000')).toBe('open');
  });

  test('another listener on the same machine is still refused', async () => {
    const pages = web();
    const node = await sync(declared, DEV, pages.origin);
    expect(await statusOf(node.url, `http://127.0.0.1:${pages.port + 7}`)).toBe(403);
    // Dev also admits the origin a request was reached on, beside the declaration.
    expect(await statusOf(node.url, new URL(node.url.replace(/^ws/, 'http')).origin)).toBe('open');
    expect((await node.mounted(pages.origin, 'https://evil.example.com'))?.status).toBe(403);
  });

  test('with no APP_URL nothing is added: the origin the node was reached on still decides', async () => {
    const pages = web();
    const node = await sync({}, DEV, pages.origin);
    // A forwarded host (a Codespace, a tunnel) is the page's origin and the request's host alike.
    const forwarded = 'https://dev-3000.preview.example.com';
    expect(await node.mounted(forwarded, forwarded)).toBeUndefined();
  });
});

describe('unit · the combined-role container, APP_URL declared', () => {
  test('declared and correct: the page is admitted', async () => {
    const pages = web();
    const node = await sync({ APP_URL: 'https://www.example.com' }, CONTAINER, pages.origin);
    expect(await statusOf(node.url, 'https://www.example.com')).toBe('open');
    expect(await node.mounted('http://www.example.com', 'https://www.example.com')).toBeUndefined();
  });

  test('declared but wrong: refused, and the web role’s own origin is NOT added in production', async () => {
    const pages = web();
    const node = await sync({ APP_URL: 'https://www.example.com' }, CONTAINER, pages.origin);
    expect(await statusOf(node.url, pages.origin)).toBe(403);
    expect((await node.mounted(pages.origin, pages.origin))?.status).toBe(403);
  });

  test('the refusal names the declared origin and the one that asked, and its fix admits it', async () => {
    const pages = web();
    const node = await sync({ APP_URL: 'https://www.example.com/' }, CONTAINER, pages.origin);
    const refused = await handshake(node.url, 'https://app.example.com');
    if (refused === 'open') expect.unreachable('a page APP_URL does not name was admitted');
    else {
      const { error } = (await refused.json()) as {
        error: { code: string; cause: string; fix: string };
      };
      expect(error.code).toBe('X_SOCKET_ORIGIN_REFUSED');
      expect(error.cause).toContain('https://www.example.com');
      expect(error.cause).toContain('https://app.example.com');
      expect(error.fix).toStartWith('export APP_URL=https://app.example.com ');
    }
  });
});

// `port: 0` is a scratch server — `x shot`, a test — and its pages dial `/_x/sync` on their own
// origin (`sync-url.ts`), never a neighbouring port. Deriving `PORT + 1` from the kernel's answer
// asked for one SPECIFIC port nobody had checked, and under load another socket held it: the
// boot died `X_PORT_IN_USE` (role-realtime.test.ts, reproduced 6 of 20 with 12,000 loopback
// connections held). Held deliberately here, so the race is the test's and not the kernel's.
describe('unit · a scratch server`s node takes a port the kernel picks', () => {
  test('the web port`s neighbour is held by another socket, and the node still binds', async () => {
    let pages = web();
    let held: { stop: (force?: boolean) => void } | undefined;
    while (held === undefined) {
      try {
        held = Bun.serve({ port: pages.port + 1, hostname: '127.0.0.1', fetch: page });
      } catch {
        pages = web();
      }
    }
    const neighbour = held;
    stops.push(() => neighbour.stop(true));
    const node = await sync({}, DEV, pages.origin);
    const bound = Number(new URL(node.url).port);
    expect(bound).toBeGreaterThan(0);
    expect(bound).not.toBe(pages.port);
    // A listener that answers, not a number: the node's own origin opens a socket on it.
    expect(await dial(node.url, new URL(node.url.replace(/^ws/, 'http')).origin)).toBe('open');
  });
});
