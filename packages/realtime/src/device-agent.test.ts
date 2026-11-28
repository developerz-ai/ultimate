// A device agent against a REAL Bun server mounting a `deviceSocket()`: the bearer token rides the
// upgrade's headers, a request from "an action" reaches the device and its answer comes back, and a
// drain's `reconnect` frame sends the agent to redial on the slot it was given.

import { afterEach, describe, expect, test } from 'bun:test';
import { markListening } from '@ultimat3/core';
import { CLOSE } from './close-codes';
import { type DeviceAgent, deviceAgent } from './device-agent';
import { deviceActor, ORG_A } from './device-fixture';
import {
  type DeviceAttachment,
  type DeviceSocket,
  deviceSocket,
  forgetDeviceSockets,
} from './device-socket';
import type { DeviceWsData } from './device-upgrade';
import { DEVICE_WIRE_VERSION } from './device-wire';
import { InProcessTransport } from './fanout';
import type { JsonValue } from './json';

let paths = 0;
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  // A path is declared once per process: a rerun in the same process (flake-hunt) declares the
  // same `/agent-test-<n>` again, which is the duplicate the registry refuses.
  forgetDeviceSockets();
});

async function serve(onFrame: (frame: JsonValue) => JsonValue | undefined = () => undefined) {
  paths += 1;
  const link: DeviceSocket = deviceSocket({
    path: `/agent-test-${paths}`,
    resolveToken: (token) =>
      token === 'device-secret' ? { actor: deviceActor('owner', ORG_A), deviceId: 'dev-1' } : null,
    onFrame: ({ frame }) => onFrame(frame),
    heartbeatMs: 1_000,
  });
  const attachment: DeviceAttachment = await link.attach({
    transport: new InProcessTransport(),
    serve: true,
    lifecycle: false,
  });
  const server = Bun.serve<DeviceWsData>({
    port: 0,
    hostname: '127.0.0.1',
    fetch: (request, srv) => link.fetch(request, srv),
    websocket: link.websocket,
  });
  const release = markListening(server.url.origin);
  cleanups.push(() => {
    attachment.stop();
    release();
    server.stop(true);
  });
  const url = `ws://127.0.0.1:${server.port}${link.path}`;
  return { link, attachment, url, http: `http://127.0.0.1:${server.port}${link.path}` };
}

/** Resolves once `link` holds `count` sockets — asked on each agent event, never on a timer. */
function connected(link: DeviceSocket, count: number, agent: () => DeviceAgent): Promise<void> {
  return new Promise((resolve) => {
    const check = (): void => {
      if (link.connected === count && agent().connected) resolve();
      else queueMicrotask(() => setImmediate(check));
    };
    check();
  });
}

const caller = { actor: deviceActor('caller', ORG_A) };

describe('e2e · a device agent over a real socket', () => {
  test('an upgrade with no token is 401 with the bearer challenge, over real HTTP', async () => {
    const { http } = await serve();
    const response = await fetch(http, {
      headers: { upgrade: 'websocket', connection: 'upgrade' },
    });
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe('Bearer');
  });

  test('a request from the server side is answered by the agent', async () => {
    const { link, url } = await serve();
    const agent = deviceAgent({
      url,
      token: () => 'device-secret',
      onRequest: (frame) => ({ got: frame }),
    });
    cleanups.push(() => agent.close());
    await connected(link, 1, () => agent);
    expect(await link.request(caller, 'dev-1', { cmd: 'status' })).toEqual({
      got: { cmd: 'status' },
    });
  });

  test("the agent's frame reaches onFrame and the answer comes back", async () => {
    const { link, url } = await serve((frame) => ({ ack: frame }));
    const answers: JsonValue[] = [];
    let heard: () => void = () => undefined;
    const answered = new Promise<void>((resolve) => {
      heard = resolve;
    });
    const agent = deviceAgent({
      url,
      token: () => 'device-secret',
      onRequest: () => null,
      onFrame: (frame) => {
        answers.push(frame);
        heard();
      },
    });
    cleanups.push(() => agent.close());
    await connected(link, 1, () => agent);
    expect(agent.send({ temp: 21 })).toBe(true);
    await answered;
    expect(answers).toEqual([{ ack: { temp: 21 } }]);
  });

  test('a drain sends the agent away and it redials on its slot', async () => {
    const { link, url, attachment } = await serve();
    let dials = 0;
    const agent = deviceAgent({
      url,
      token: () => {
        dials += 1;
        return 'device-secret';
      },
      onRequest: () => null,
    });
    cleanups.push(() => agent.close());
    await connected(link, 1, () => agent);
    await attachment.drain({ graceMs: 0, spreadMs: 20 });
    // The drain stopped accepting for good on this node; a fresh attach is the "next node".
    attachment.stop();
    const next = await link.attach({
      transport: new InProcessTransport(),
      serve: true,
      lifecycle: false,
    });
    cleanups.push(() => next.stop());
    await connected(link, 1, () => agent);
    expect(dials).toBeGreaterThanOrEqual(2);
  });
});

describe('unit · a device agent closed mid-dial', () => {
  test('close() while the token is still being fetched dials nothing', async () => {
    let release: (token: string) => void = () => undefined;
    const token = new Promise<string>((resolve) => {
      release = resolve;
    });
    let dials = 0;
    const agent = deviceAgent({
      url: 'ws://device.test/link',
      token: () => token,
      onRequest: () => null,
      dial: () => {
        dials += 1;
        return { send() {}, close() {}, onopen: null, onmessage: null, onclose: null };
      },
    });
    agent.close();
    release('device-secret');
    await token;
    await Promise.resolve();
    expect(dials).toBe(0);
    expect(agent.connected).toBe(false);
  });
});

describe('unit · a device agent meets a newer wire', () => {
  const hello = (v: number | undefined) =>
    JSON.stringify({
      type: 'hello',
      ...(v === undefined ? {} : { v }),
      heartbeatMs: 5,
      maxFrameBytes: 9,
    });

  async function against(text: string) {
    const closes: { code: number | undefined; reason: string | undefined }[] = [];
    const beats: number[] = [];
    const socket = {
      send() {},
      close(code?: number, reason?: string) {
        closes.push({ code, reason });
      },
      onopen: null as (() => void) | null,
      onmessage: null as ((event: { readonly data: unknown }) => void) | null,
      onclose: null as (() => void) | null,
    };
    const agent = deviceAgent({
      url: 'ws://device.test/link',
      token: () => 't',
      onRequest: () => null,
      dial: () => socket,
      schedule: (_run, ms) => {
        beats.push(ms);
        return () => undefined;
      },
    });
    cleanups.push(() => agent.close());
    await Promise.resolve();
    await Promise.resolve();
    socket.onmessage?.({ data: text });
    return { closes, beats };
  }

  test('a hello with v above DEVICE_WIRE_VERSION closes with X_DEVICE_WIRE_VERSION, no beat', async () => {
    const { closes, beats } = await against(hello(DEVICE_WIRE_VERSION + 1));
    expect(closes).toEqual([{ code: CLOSE.versionSkew, reason: 'X_DEVICE_WIRE_VERSION' }]);
    expect(beats).toEqual([]);
  });

  test('a hello at the spoken version, or with no v, beats and stays open', async () => {
    for (const v of [DEVICE_WIRE_VERSION, undefined]) {
      const { closes, beats } = await against(hello(v));
      expect(closes).toEqual([]);
      expect(beats).toEqual([5]);
    }
  });
});

describe('unit · a device agent redialing against a newer wire', () => {
  test('each version-skew close backs off further: an opened socket is not a healthy one', async () => {
    const delays: number[] = [];
    const pending: (() => void)[] = [];
    const agent = deviceAgent({
      url: 'ws://device.test/link',
      token: () => 't',
      onRequest: () => null,
      backoff: { base: 100, max: 100_000, factor: 2, jitter: 'none' },
      schedule: (run, ms) => {
        delays.push(ms);
        pending.push(run);
        return () => undefined;
      },
      dial: () => {
        const socket = {
          send() {},
          close() {
            socket.onclose?.();
          },
          onopen: null as (() => void) | null,
          onmessage: null as ((event: { readonly data: unknown }) => void) | null,
          onclose: null as (() => void) | null,
        };
        queueMicrotask(() => {
          socket.onopen?.();
          socket.onmessage?.({
            data: JSON.stringify({
              type: 'hello',
              v: DEVICE_WIRE_VERSION + 1,
              heartbeatMs: 5,
              maxFrameBytes: 9,
            }),
          });
        });
        return socket;
      },
    });
    cleanups.push(() => agent.close());
    for (let round = 0; round < 4; round += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      for (const run of pending.splice(0)) run();
    }
    expect(delays.length).toBeGreaterThanOrEqual(3);
    expect(delays.slice(0, 3)).toEqual([...delays.slice(0, 3)].sort((a, b) => a - b));
    expect(delays[2]).toBeGreaterThan(delays[0] ?? 0);
  });
});
