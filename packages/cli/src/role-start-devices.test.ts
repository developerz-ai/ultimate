// A declared `deviceSocket()` is reachable through the web role the boot really starts — alone, and
// beside the sync node on the same port. A real socket and a real device agent: the upgrade's auth,
// the frame and the node's answer all cross the listener `startRoles` bound, not a hand-built one.
// Under it, `hostDeviceSockets`: every role attaches, only `web` serves, and `refresh()` swaps in a
// path's re-declaration (`x dev`'s rescan) without the listener moving.

import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises'; // why: Bun has no recursive remove, only a per-file delete.
import { isUltimateError, userActor } from '@ultimat3/core';
import type { JsonValue } from '@ultimat3/realtime';
import {
  beginDeviceSocketGeneration,
  type DeviceSocket,
  type DeviceWsData,
  deviceAgent,
  deviceSocket,
  forgetDeviceSockets,
  InProcessTransport,
} from '@ultimat3/realtime/server';
import type { RunningRoles } from './role-start';
import { selectRoles, startRoles } from './role-start';
import { type DeviceHosting, hostDeviceSockets } from './role-start-devices';
import { fixtureRuntime, resetDevRolesState } from './role-start-fixture';

const ROOT = `${import.meta.dir}/../.roles-devices-fixture`;
const PATH = '/role-start-link';
const actor = userActor({ id: 'owner', orgId: 'org-1' });

let running: RunningRoles | undefined;

const hostings: DeviceHosting[] = [];

afterEach(async () => {
  await running?.stop();
  running = undefined;
  for (const hosting of hostings.splice(0)) await hosting.stop();
  forgetDeviceSockets();
  resetDevRolesState();
});

afterAll(async () => {
  await rm(ROOT, { recursive: true, force: true });
});

const declare = () =>
  deviceSocket({
    path: PATH,
    resolveToken: (token) => (token === 'ok' ? { actor, deviceId: 'desk-1' } : null),
    onFrame: ({ frame, device }) => ({ ack: device.deviceId, received: frame }),
  });

const boot = async (roles: string): Promise<string> => {
  running = await startRoles({
    roles: selectRoles(roles),
    port: 0,
    metricsPort: 0,
    buildId: 'test',
    runtime: fixtureRuntime(ROOT),
    env: {},
    routes: [],
  });
  return running.url ?? expect.unreachable('the web role bound no port');
};

/** Until the node has let go of every socket — else the stop's drain waits out its grace for one. */
const released = (link: DeviceSocket): Promise<void> =>
  new Promise((resolve) => {
    const check = (): void => {
      if (link.connected === 0) resolve();
      else setImmediate(check);
    };
    check();
  });

/** One status frame from a device, and what the node's `onFrame` answered over the socket. */
const reported = (url: string): Promise<JsonValue> =>
  new Promise((resolve) => {
    const agent = deviceAgent({
      url,
      token: () => 'ok',
      onRequest: (frame) => frame,
      onFrame: (frame) => {
        agent.close();
        resolve(frame);
      },
    });
    // The agent's open is its own event; a frame sent before it is refused (`false`), so retry on
    // the next turn rather than on a timer.
    const send = (): void => {
      if (!agent.send({ status: 'idle' })) setImmediate(send);
    };
    send();
  });

describe('unit · startRoles serves every declared device socket on the web listener', () => {
  test('the web role alone: a device dials, authenticates and is answered', async () => {
    const link = declare();
    const app = await boot('web');
    expect(await reported(`${app.replace('http', 'ws')}${PATH}`)).toEqual({
      ack: 'desk-1',
      received: { status: 'idle' },
    });
    await released(link);
  });

  test('beside the sync node, on the same port — both doors answer', async () => {
    const link = declare();
    const app = await boot('web,sync');
    const ws = app.replace('http', 'ws');
    expect(await reported(`${ws}${PATH}`)).toEqual({
      ack: 'desk-1',
      received: { status: 'idle' },
    });
    await released(link);
    const sync = new WebSocket(`${ws}/_x/sync?build=test`);
    const opened = await new Promise<string>((resolve) => {
      sync.addEventListener('open', () => resolve('open'));
      sync.addEventListener('close', (event) => resolve(`closed ${event.code} ${event.reason}`));
    });
    sync.close();
    expect(opened).toBe('open');
  });

  test('the upgrade is still refused without a valid token, in the real boot', async () => {
    declare();
    const app = await boot('web');
    const answer = await fetch(`${app}${PATH}`, {
      headers: { upgrade: 'websocket', connection: 'upgrade', authorization: 'Bearer forged' },
    });
    expect(answer.status).toBe(401);
  });
});

const reasonOf = async (work: Promise<unknown>): Promise<string> => {
  try {
    await work;
  } catch (error) {
    return isUltimateError(error) ? `${error.code} ${error.cause}` : 'not coded';
  }
  return expect.unreachable('the request resolved');
};

/** An upgrade target that accepts, recording what it was asked to open. */
const target = () => {
  const opened: DeviceWsData[] = [];
  return {
    opened,
    upgrade: (_request: Request, options: { data: DeviceWsData }) => {
      opened.push(options.data);
      return true;
    },
    requestIP: () => null,
  };
};

const upgrade = () =>
  new Request(`http://app.test${PATH}`, { headers: { authorization: 'Bearer ok' } });

const host = async (roles: string): Promise<DeviceHosting> => {
  const hosting = await hostDeviceSockets(new InProcessTransport(), selectRoles(roles));
  hostings.push(hosting);
  return hosting;
};

describe('unit · hostDeviceSockets', () => {
  test('a worker addresses devices over the bus but serves none', async () => {
    const link = declare();
    expect(await reasonOf(link.request({ actor }, 'desk-1', {}))).toContain('never attached');
    const hosting = await host('worker');
    expect(hosting.mounts).toEqual([]);
    expect(await reasonOf(link.request({ actor }, 'desk-1', {}))).toContain('no node holds');
    expect((await link.fetch(upgrade(), target()))?.status).toBe(503);
  });

  test('the web role serves them, through one door per declared path', async () => {
    declare();
    const hosting = await host('web,worker');
    expect(hosting.mounts.map((mount) => mount.path)).toEqual([PATH]);
    const accepted = target();
    expect(await hosting.mounts[0]?.fetch(upgrade(), accepted)).toBeUndefined();
    expect(accepted.opened.map((data) => data.grant.deviceId)).toEqual(['desk-1']);
  });

  test('stopped, the declaration may be attached again by the next boot', async () => {
    declare();
    await (await hostDeviceSockets(new InProcessTransport(), ['web'])).stop();
    await host('web');
  });

  test('refresh: a re-declared path is attached and its door answers with the new value', async () => {
    const before = declare();
    const hosting = await host('web');
    expect(await hosting.refresh()).toEqual([]);
    beginDeviceSocketGeneration();
    const after = deviceSocket({
      path: PATH,
      resolveToken: () => ({ actor, deviceId: 'desk-2' }),
      onFrame: () => undefined,
    });
    expect(await hosting.refresh()).toEqual([]);
    expect(await reasonOf(after.request({ actor }, 'desk-2', {}))).toContain('no node holds');
    expect(await reasonOf(before.request({ actor }, 'desk-1', {}))).toContain('never attached');
    const accepted = target();
    expect(await hosting.mounts[0]?.fetch(upgrade(), accepted)).toBeUndefined();
    expect(accepted.opened.map((data) => data.grant.deviceId)).toEqual(['desk-2']);
  });

  test('refresh answers a path declared after the listener bound, which it cannot serve', async () => {
    declare();
    const hosting = await host('web');
    deviceSocket({ path: '/late-link', resolveToken: () => null, onFrame: () => undefined });
    expect(await hosting.refresh()).toEqual(['/late-link']);
  });
});
