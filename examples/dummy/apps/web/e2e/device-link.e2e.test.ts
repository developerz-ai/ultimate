/**
 * e2e — issue #995: the device link (`app/devices/link.ts`) is reachable in the boot the app really
 * ships. Postly is started twice — the production entry under `ROLE=web` and `x dev` (the sync
 * node on the same port beside it) — and a desktop agent dials `/link` over a real socket with an
 * enrolment token, sends a status frame and reads the node's acknowledgement. A forged token is a
 * 401 before any socket, in the same process.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Clock } from '@ultimat3/core';
import type { JsonValue } from '@ultimat3/realtime';
import { deviceAgent } from '@ultimat3/realtime/server';
import type { E2eApp, E2eAppMode } from '@ultimat3/testing';
import { E2E_APP_START_MS, E2E_APP_STOP_MS } from '@ultimat3/testing';
import { mintDeviceToken } from '../app/devices/token';
import { startPostly } from './fixtures/postly';

const ORG = '00000000-0000-4000-8000-0000000000d1';
const enrolment = { orgId: ORG, ownerId: 'owner-1', deviceId: 'desk-7' };

/**
 * The app is another process on the machine's own clock; this one's is frozen by the preload at an
 * instant months before it. A token minted on the frozen clock would be expired where it is opened,
 * so the expiry is minted against real time — `performance`, which the preload does not move.
 */
const machineClock: Clock = {
  now: () => new Date(performance.timeOrigin + performance.now()),
  monotonic: () => performance.now(),
};

/** One status frame from the device, and what the app's `onFrame` acknowledged over the socket. */
const report = (url: string, token: string): Promise<JsonValue> =>
  new Promise((resolve) => {
    const agent = deviceAgent({
      url,
      token: () => token,
      onRequest: (frame) => frame,
      onFrame: (frame) => {
        agent.close();
        resolve(frame);
      },
    });
    // `send` answers `false` until the socket is open; asked again next turn, never on a timer.
    const send = (): void => {
      if (!agent.send({ status: 'idle' })) setImmediate(send);
    };
    send();
  });

const modes: readonly E2eAppMode[] = ['serve', 'dev'];

for (const mode of modes) {
  describe(`the device link through ${mode === 'serve' ? 'the production web role' : 'x dev'}`, () => {
    let app: E2eApp;

    beforeAll(async () => {
      app = await startPostly(mode);
    }, E2E_APP_START_MS);

    afterAll(async () => {
      await app?.stop();
    }, E2E_APP_STOP_MS);

    test('an enrolled device dials /link and its status frame is acknowledged', async () => {
      const token = await mintDeviceToken(enrolment, { clock: machineClock });
      const answer = await report(`${app.base.replace(/^http/, 'ws')}/link`, token);
      expect(answer).toEqual({ ack: 'desk-7', received: { status: 'idle' } });
    });

    test('a forged token is refused at the upgrade, before any socket', async () => {
      const answer = await fetch(`${app.base}/link`, {
        headers: {
          upgrade: 'websocket',
          connection: 'upgrade',
          authorization: 'Bearer not-a-sealed-token',
        },
      });
      expect(answer.status).toBe(401);
      expect(answer.headers.get('www-authenticate')).toBe('Bearer error="invalid_token"');
    });
  });
}
