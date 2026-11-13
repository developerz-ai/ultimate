// The security review's reproduction, end to end in one process: a real `@ultimat3/auth` session,
// the authenticator shape every `x new` app shipped (auth's refusal THROWN through, never `null`),
// a live subscription on a real `sync` node, then `logout()`. Before the fix the sweep answered
// `{ refreshed: 0, revoked: 0, failed: 1 }` and the socket kept streaming under the signed-out
// actor; the Postgres twin of the revocation is `sync-authenticator.live.test.ts`.

import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test';
import {
  authenticate,
  defineAuth,
  login,
  logout,
  memoryAuthAdapter,
  register,
} from '@ultimat3/auth';
import { frozenClock } from '@ultimat3/core';
import { configureAuthenticator, resetAuthenticator } from '@ultimat3/http';
import { encode, PROTOCOL_VERSION } from '@ultimat3/realtime';
import {
  ChannelHub,
  CLOSE,
  InProcessTransport,
  type LiveQueryDefinition,
  LiveQueryRegistry,
  RingChangeBuffer,
  SocketRegistry,
  type SyncWs,
  syncNode,
  type WsData,
} from '@ultimat3/realtime/server';
import { syncAuthenticator } from './sync-authenticator';

const BUILD_ID = 'build-1';
const TTL_MS = 60_000;
const PASSWORD = 'a long sync logout test passphrase';

beforeEach(resetAuthenticator);
afterEach(() => {
  resetAuthenticator();
  jest.useRealTimers();
});

/** The org's live records: whoever holds the socket reads them. */
const orgFeed: LiveQueryDefinition = {
  name: 'orgFeed',
  entities: ['posts'],
  snapshot: async () => ({ rows: [{ id: 'p1', orgId: 'o1' }], lsn: '' }),
  visible: () => true,
  matcher: () => ({ entities: ['posts'], match: () => ({ patches: [], refill: false }) }),
};

/** The socket as the client sees it: every frame it was sent and every close, in order. */
class ClientWs {
  readonly frames: string[] = [];
  readonly closes: (readonly [number, string])[] = [];
  data!: WsData;
  send(raw: string): number {
    this.frames.push(raw);
    return raw.length;
  }
  close(code = 0, reason = ''): void {
    this.closes.push([code, reason]);
  }
  subscribe(): void {}
  unsubscribe(): void {}
  getBufferedAmount(): number {
    return 0;
  }
}

/** Every promise the node chained settles: the in-process bus and the fakes answer on microtasks. */
const settle = async (): Promise<void> => {
  for (let tick = 0; tick < 50; tick += 1) await Promise.resolve();
};

describe('logout() closes the live socket its cookie opened', () => {
  test('a thrown X_UNAUTHENTICATED on re-check revokes the grant and closes with 1008', async () => {
    const auth = defineAuth({ adapter: memoryAuthAdapter() });
    await register(auth, { email: 'ada@example.com', password: PASSWORD, orgId: 'o1' });
    const { token } = await login(auth, { email: 'ada@example.com', password: PASSWORD });
    const cookieName = auth.sessions.policy.cookieName;
    // The defect's shape, verbatim: a stale cookie reaches the node as auth's own THROW.
    configureAuthenticator((request) => {
      const cookie = request.cookie(cookieName);
      return cookie === null ? null : authenticate(auth, cookie);
    });

    jest.useFakeTimers();
    const clock = frozenClock(0);
    const sockets = new SocketRegistry({ clock });
    const transport = new InProcessTransport();
    const node = syncNode({
      hub: new ChannelHub({ transport, sockets }),
      registry: new LiveQueryRegistry({ source: new RingChangeBuffer() }).register(orgFeed),
      transport,
      buildId: BUILD_ID,
      sockets,
      clock,
      authenticate:
        syncAuthenticator(BUILD_ID, { clock, ttlMs: TTL_MS }) ?? expect.unreachable('no auth'),
      reauthenticateIntervalMs: 1,
    });
    await node.start();
    const ws = new ClientWs();
    const upgrade = new Request('http://node/_x/sync', {
      headers: { cookie: `${cookieName}=${token}` },
    });
    const refused = await node.fetch(upgrade, {
      upgrade(_request, options) {
        ws.data = options.data;
        node.websocket.open(ws as unknown as SyncWs);
        return true;
      },
      requestIP: () => null,
    });
    expect(refused).toBeUndefined();
    node.websocket.message(
      ws as unknown as SyncWs,
      encode({
        type: 'subscribe',
        v: PROTOCOL_VERSION,
        op: 'add',
        sid: 'q-1',
        target: { kind: 'query', qid: 'orgFeed', input: {}, cursor: null },
      }),
    );
    await settle();
    expect(ws.frames.some((raw) => raw.includes('"snapshot"'))).toBe(true);

    expect(await logout(auth, token)).toBe(true);
    clock.advance(TTL_MS + 1);
    for (let tick = 0; tick < 20 && ws.closes.length === 0; tick += 1) {
      jest.advanceTimersByTime(1);
      await settle();
    }

    expect(ws.closes).toEqual([[CLOSE.policy, 'grant expired']]);
    expect(sockets.get(ws.data.socketId)).toBeUndefined();
    await node.stop();
  });
});
