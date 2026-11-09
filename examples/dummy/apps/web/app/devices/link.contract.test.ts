// The device link over a REAL socket: a Bun server mounting `deviceLink`, a device agent dialling
// it with a minted token, and a request from an org-scoped caller answered by that device. The
// attacks are the same dial with no token, a forged one, an expired one, and another org's caller.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { frozenClock, isUltimateError, markListening, userActor } from '@ultimat3/core';
import {
  type DeviceAttachment,
  type DeviceWsData,
  deviceAgent,
  InProcessTransport,
} from '@ultimat3/realtime/server';
import { deviceLink } from './link';
import { mintDeviceToken } from './token';

const ORG = '00000000-0000-4000-8000-0000000000d1';
const OTHER_ORG = '00000000-0000-4000-8000-0000000000d2';
const enrolment = { orgId: ORG, ownerId: 'owner-1', deviceId: 'desk-7' };

let attachment: DeviceAttachment;
let stopServer: () => void = () => undefined;
let base = '';

beforeAll(async () => {
  attachment = await deviceLink.attach({
    transport: new InProcessTransport(),
    serve: true,
    lifecycle: false,
  });
  const server = Bun.serve<DeviceWsData>({
    port: 0,
    hostname: '127.0.0.1',
    fetch: (request, srv) => deviceLink.fetch(request, srv),
    websocket: deviceLink.websocket,
  });
  const release = markListening(server.url.origin);
  stopServer = () => {
    release();
    server.stop(true);
  };
  base = `127.0.0.1:${server.port}${deviceLink.path}`;
});

afterAll(() => {
  attachment.stop();
  stopServer();
});

const upgradeWith = (authorization?: string) =>
  fetch(`http://${base}`, {
    headers: {
      upgrade: 'websocket',
      connection: 'upgrade',
      ...(authorization === undefined ? {} : { authorization }),
    },
  });

const codeOf = async (work: Promise<unknown>): Promise<string> => {
  try {
    await work;
  } catch (error) {
    return isUltimateError(error) ? error.code : 'not coded';
  }
  return expect.unreachable('the request resolved');
};

describe('contract · the device link', () => {
  test('a request from the device owner org is answered by the connected device', async () => {
    const token = await mintDeviceToken(enrolment);
    const agent = deviceAgent({
      url: `ws://${base}`,
      token: () => token,
      onRequest: (frame) => ({ ran: frame }),
    });
    try {
      await new Promise<void>((resolve) => {
        const ready = (): void => {
          if (deviceLink.connected === 1 && agent.connected) resolve();
          else setImmediate(ready);
        };
        ready();
      });
      const caller = { actor: userActor({ id: 'admin-1', orgId: ORG }) };
      expect(await deviceLink.request(caller, 'desk-7', { job: 'sync' })).toEqual({
        ran: { job: 'sync' },
      });
      const stranger = { actor: userActor({ id: 'admin-2', orgId: OTHER_ORG }) };
      expect(await codeOf(deviceLink.request(stranger, 'desk-7', { job: 'wipe' }))).toBe(
        'X_DEVICE_OFFLINE',
      );
    } finally {
      agent.close();
    }
  });

  test('no token, a forged one and an expired one are each a 401 before any socket', async () => {
    const expired = await mintDeviceToken(enrolment, {
      clock: frozenClock('2020-01-01T00:00:00.000Z'),
      ttlMs: 1_000,
    });
    const answers = await Promise.all([
      upgradeWith(),
      upgradeWith('Bearer not-a-sealed-token'),
      upgradeWith(`Bearer ${expired}`),
    ]);
    expect(answers.map((answer) => answer.status)).toEqual([401, 401, 401]);
    expect(answers[0]?.headers.get('www-authenticate')).toBe('Bearer');
    expect(answers[1]?.headers.get('www-authenticate')).toBe('Bearer error="invalid_token"');
  });
});
