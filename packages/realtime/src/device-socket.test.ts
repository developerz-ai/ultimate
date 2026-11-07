// `deviceSocket()` end to end on one node, over the in-process bus: the upgrade opens a socket the
// way Bun does, frames go through the mount's own handlers, and every timer is moved by hand.

import { afterEach, describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import {
  deviceActor,
  type FakeDeviceWs,
  manualScheduler,
  ORG_A,
  ORG_B,
  testClock,
  upgradeRequest,
  upgradeTarget,
} from './device-fixture';
import type { DeviceFrameHandler } from './device-host';
import { type DeviceAttachment, deviceSocket } from './device-socket';
import type { DeviceGrant } from './device-upgrade';
import { DEVICE_FRAME_MAX_BYTES } from './device-wire';
import { InProcessTransport } from './fanout';

let paths = 0;
const attachments: DeviceAttachment[] = [];
afterEach(() => {
  for (const attachment of attachments.splice(0)) attachment.stop();
});

const flush = async (): Promise<void> => {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
};

const codeOf = async (work: Promise<unknown>): Promise<string> => {
  try {
    await work;
  } catch (error) {
    return isUltimateError(error) ? error.code : 'not coded';
  }
  return expect.unreachable('the request resolved');
};

async function node(options: { onFrame?: DeviceFrameHandler; heartbeatMs?: number } = {}) {
  const clock = testClock();
  const timers = manualScheduler(clock);
  const grants = new Map<string, DeviceGrant>([
    ['tok-a', { actor: deviceActor('dev-owner', ORG_A), deviceId: 'dev-1' }],
    ['tok-b', { actor: deviceActor('other-owner', ORG_B), deviceId: 'dev-9' }],
    [
      'tok-short',
      {
        actor: deviceActor('dev-owner', ORG_A),
        deviceId: 'dev-2',
        expiresAt: clock.now().getTime() + 20_000,
      },
    ],
  ]);
  paths += 1;
  const link = deviceSocket({
    path: `/device-test-${paths}`,
    resolveToken: (token) => grants.get(token) ?? null,
    onFrame: options.onFrame ?? (() => undefined),
    heartbeatMs: options.heartbeatMs ?? 10_000,
  });
  const attachment = await link.attach({
    transport: new InProcessTransport(),
    clock,
    rng: () => 0.5,
    schedule: timers.schedule,
    serve: true,
    lifecycle: false,
  });
  attachments.push(attachment);
  const target = upgradeTarget(link.websocket);
  const dial = async (token: string): Promise<FakeDeviceWs> => {
    const answer = await link.fetch(upgradeRequest(link.path, token), target);
    expect(answer).toBeUndefined();
    await flush();
    const ws = target.sockets.at(-1);
    if (ws === undefined) return expect.unreachable('no socket opened');
    return ws;
  };
  const caller = { actor: deviceActor('caller', ORG_A) };
  return { link, attachment, timers, dial, caller, target };
}

/** The `request` frames a device was sent, answered by the test. */
const requestsTo = (ws: FakeDeviceWs) =>
  ws.sent.filter(
    (frame): frame is { type: 'request'; id: string; frame: unknown } =>
      (frame as { type?: string }).type === 'request',
  );

describe('unit · deviceSocket request/response', () => {
  test('a request reaches the device and resolves with its response', async () => {
    const { link, dial, caller } = await node();
    const ws = await dial('tok-a');
    expect(ws.sent[0]).toEqual({
      type: 'hello',
      heartbeatMs: 10_000,
      maxFrameBytes: DEVICE_FRAME_MAX_BYTES,
    });
    const answer = link.request(caller, 'dev-1', { cmd: 'status' });
    await flush();
    const [asked] = requestsTo(ws);
    expect(asked?.frame).toEqual({ cmd: 'status' });
    link.websocket.message(
      ws,
      JSON.stringify({ type: 'response', id: asked?.id, frame: { ok: true } }),
    );
    expect(await answer).toEqual({ ok: true });
  });

  test("another tenant's device is X_DEVICE_OFFLINE at once, as an unknown one is", async () => {
    const { link, dial, caller, timers } = await node();
    const foreign = await dial('tok-b');
    const before = timers.pending;
    expect(await codeOf(link.request(caller, 'dev-9', { cmd: 'wipe' }))).toBe('X_DEVICE_OFFLINE');
    expect(await codeOf(link.request(caller, 'nope', {}))).toBe('X_DEVICE_OFFLINE');
    expect(requestsTo(foreign)).toHaveLength(0);
    expect(timers.pending).toBe(before);
  });

  test('no response before the deadline is X_DEVICE_REQUEST_TIMEOUT', async () => {
    const { link, dial, caller, timers } = await node();
    await dial('tok-a');
    const answer = codeOf(link.request(caller, 'dev-1', {}, { deadlineMs: 2_000 }));
    await flush();
    timers.advance(2_000);
    expect(await answer).toBe('X_DEVICE_REQUEST_TIMEOUT');
  });

  test('a socket that closes mid-request cancels it as X_DEVICE_OFFLINE, before the deadline', async () => {
    const { link, dial, caller } = await node();
    const ws = await dial('tok-a');
    const answer = codeOf(link.request(caller, 'dev-1', {}, { deadlineMs: 60_000 }));
    await flush();
    ws.close(1000, 'gone');
    expect(await answer).toBe('X_DEVICE_OFFLINE');
  });

  test('a response for a request this socket was never sent is ignored', async () => {
    const { link, dial, caller, timers } = await node();
    const ws = await dial('tok-a');
    const answer = codeOf(link.request(caller, 'dev-1', {}, { deadlineMs: 1_000 }));
    await flush();
    link.websocket.message(ws, JSON.stringify({ type: 'response', id: 'forged', frame: 1 }));
    timers.advance(1_000);
    expect(await answer).toBe('X_DEVICE_REQUEST_TIMEOUT');
  });

  test('a request frame past the limit is refused before it is sent', async () => {
    const { link, dial, caller } = await node();
    await dial('tok-a');
    const huge = 'x'.repeat(DEVICE_FRAME_MAX_BYTES);
    expect(await codeOf(link.request(caller, 'dev-1', huge))).toBe('X_DEVICE_FRAME_TOO_LARGE');
  });
});

describe('unit · deviceSocket bounds', () => {
  test('an oversized frame closes the socket 1009 and never reaches onFrame', async () => {
    const seen: unknown[] = [];
    const { link, dial } = await node({ onFrame: ({ frame }) => void seen.push(frame) });
    const ws = await dial('tok-a');
    const frame = JSON.stringify({ type: 'frame', frame: 'x'.repeat(DEVICE_FRAME_MAX_BYTES) });
    link.websocket.message(ws, frame);
    await flush();
    expect(ws.closed).toEqual({ code: 1009, reason: 'X_DEVICE_FRAME_TOO_LARGE' });
    expect(seen).toEqual([]);
  });

  test('onFrame runs as the device actor and its answer is sent back', async () => {
    const { link, dial } = await node({
      onFrame: ({ frame, device, ctx }) => ({ echo: frame, by: ctx.actor.id, id: device.deviceId }),
    });
    const ws = await dial('tok-a');
    link.websocket.message(ws, JSON.stringify({ type: 'frame', frame: 'hi' }));
    await flush();
    expect(ws.sent.at(-1)).toEqual({
      type: 'frame',
      frame: { echo: 'hi', by: 'dev-owner', id: 'dev-1' },
    });
  });

  test('frames faster than onFrame answers close the socket X_FRAME_RATE_LIMIT', async () => {
    const { link, dial } = await node({ onFrame: () => new Promise(() => undefined) });
    const ws = await dial('tok-a');
    for (let index = 0; index < 40; index += 1) {
      link.websocket.message(ws, JSON.stringify({ type: 'frame', frame: index }));
    }
    expect(ws.closed?.reason).toBe('X_FRAME_RATE_LIMIT');
  });

  test('a frame this protocol does not speak closes the socket', async () => {
    const { link, dial } = await node();
    const ws = await dial('tok-a');
    link.websocket.message(ws, '{"type":"subscribe"}');
    expect(ws.closed?.code).toBe(1008);
  });

  test('a device silent for two beats is closed; one that beats is kept', async () => {
    const { link, dial, timers } = await node({ heartbeatMs: 10_000 });
    const silent = await dial('tok-a');
    const beating = await dial('tok-b');
    for (let beat = 0; beat < 3; beat += 1) {
      timers.advance(10_000);
      link.websocket.message(beating, '{"type":"beat"}');
    }
    timers.advance(10_000);
    expect(silent.closed).toEqual({ code: 4001, reason: 'no beat' });
    expect(beating.closed).toBeNull();
  });

  test('a grant that expires closes its socket at the next sweep', async () => {
    const { link, dial, timers } = await node({ heartbeatMs: 10_000 });
    const ws = await dial('tok-short');
    timers.advance(10_000);
    link.websocket.message(ws, '{"type":"beat"}');
    expect(ws.closed).toBeNull();
    timers.advance(10_000);
    expect(ws.closed).toEqual({ code: 1008, reason: 'grant expired' });
  });

  test('a second socket for one device replaces the first', async () => {
    const { dial } = await node();
    const first = await dial('tok-a');
    const second = await dial('tok-a');
    expect(first.closed).toEqual({ code: 1008, reason: 'replaced' });
    expect(second.closed).toBeNull();
  });

  test('drain: a reconnect slot per socket, then the close, and new dials are shed', async () => {
    const { link, attachment, dial, timers, target } = await node();
    const a = await dial('tok-a');
    const b = await dial('tok-b');
    const drained = attachment.drain({ graceMs: 1_000, spreadMs: 10_000 });
    const frames = [a, b].map((ws) => ws.sent.at(-1) as { type: string; afterMs: number });
    expect(frames.map((frame) => frame.type)).toEqual(['reconnect', 'reconnect']);
    expect(frames[0]?.afterMs).not.toBe(frames[1]?.afterMs);
    const shed = await link.fetch(upgradeRequest(link.path, 'tok-a'), target);
    expect(shed?.status).toBe(503);
    timers.advance(1_000);
    await drained;
    expect([a.closed?.code, b.closed?.code]).toEqual([1001, 1001]);
    expect(link.connected).toBe(0);
  });
});

describe('unit · deviceSocket declaration', () => {
  test('a path the framework serves, or one taken, is X_CONFIG_INVALID', async () => {
    const declare = (path: string) =>
      deviceSocket({ path, resolveToken: () => null, onFrame: () => undefined });
    const codes = ['/_x/link', '/api/link', 'link', '/Link/'].map((path) => {
      try {
        declare(path);
        return 'declared';
      } catch (error) {
        return isUltimateError(error) ? error.code : 'not coded';
      }
    });
    expect(codes).toEqual([
      'X_CONFIG_INVALID',
      'X_CONFIG_INVALID',
      'X_CONFIG_INVALID',
      'X_CONFIG_INVALID',
    ]);
    const { link } = await node();
    expect(() => declare(link.path)).toThrow('already declares');
  });

  test('a heartbeat out of range, a NaN, or a socket cap below 1 is refused', () => {
    const declare = (extra: { heartbeatMs?: number; maxSocketsPerActor?: number }) => () => {
      paths += 1;
      return deviceSocket({
        path: `/device-decl-${paths}`,
        resolveToken: () => null,
        onFrame: () => undefined,
        ...extra,
      });
    };
    expect(declare({ heartbeatMs: 10 })).toThrow('heartbeatMs');
    expect(declare({ heartbeatMs: Number.NaN })).toThrow('heartbeatMs');
    expect(declare({ maxSocketsPerActor: 0 })).toThrow('maxSocketsPerActor');
  });

  test('a request before the process attached a bus is X_DEVICE_OFFLINE, saying why', async () => {
    paths += 1;
    const link = deviceSocket({
      path: `/device-test-${paths}`,
      resolveToken: () => null,
      onFrame: () => undefined,
    });
    expect(await codeOf(link.request({ actor: deviceActor('c') }, 'dev-1', {}))).toBe(
      'X_DEVICE_OFFLINE',
    );
  });
});
