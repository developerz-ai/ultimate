// The port wire, end to end against an in-process DevTools stand-in: the browser's announcement
// file, the dial, a reply. Nothing here spawns, so it runs alike on Windows — where this wire is
// the default — and on the Linux runner.

import { afterAll, describe, expect, jest, test } from 'bun:test';
// why: Bun exposes no temp-directory primitive, no recursive remove and no synchronous write.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
// why: Bun exposes no tmpdir().
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import {
  DEVTOOLS_ACTIVE_PORT,
  defaultWire,
  devToolsEndpoint,
  portConnection,
  wireFlag,
  wireStdio,
} from './cdp-launch-wire';

const scratch = mkdtempSync(join(tmpdir(), 'x-cdp-wire-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe('the wire per platform', () => {
  test('Windows is driven over a port; every other platform over the pipe', () => {
    expect(defaultWire('win32')).toBe('port');
    expect(defaultWire('linux')).toBe('pipe');
    expect(defaultWire('darwin')).toBe('pipe');
    expect(wireFlag('port')).toBe('--remote-debugging-port=0');
    expect(wireFlag('pipe')).toBe('--remote-debugging-pipe');
    // The port wire opens no fds 3 and 4: on Windows those are what cannot be held.
    expect(wireStdio('port')).toHaveLength(3);
    expect(wireStdio('pipe')).toHaveLength(5);
  });
});

describe('devToolsEndpoint', () => {
  test('the announcement becomes a loopback WebSocket url, by address', () => {
    expect(devToolsEndpoint('9222\n/devtools/browser/4b1f-aa\n')).toBe(
      'ws://127.0.0.1:9222/devtools/browser/4b1f-aa',
    );
    expect(devToolsEndpoint('9222\r\n/devtools/browser/4b1f\r\n')).toBe(
      'ws://127.0.0.1:9222/devtools/browser/4b1f',
    );
  });

  test('a half-written or foreign file is no endpoint yet', () => {
    expect(devToolsEndpoint('')).toBeUndefined();
    expect(devToolsEndpoint('9222')).toBeUndefined();
    expect(devToolsEndpoint('0\n/devtools/browser/x')).toBeUndefined();
    expect(devToolsEndpoint('70000\n/devtools/browser/x')).toBeUndefined();
    expect(devToolsEndpoint('9222\n/json/version')).toBeUndefined();
  });
});

/** A DevTools stand-in: answers every call with its own id, as a browser endpoint does. */
const standIn = () =>
  Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (request, server) =>
      server.upgrade(request) ? undefined : new Response('upgrade', { status: 426 }),
    websocket: {
      message(socket, raw) {
        const { id } = JSON.parse(String(raw)) as { id: number };
        socket.send(JSON.stringify({ id, result: { product: 'StandIn' } }));
      },
    },
  });

describe('portConnection', () => {
  test('waits for the announcement, dials it, and the connection answers', async () => {
    const server = standIn();
    const profileDir = mkdtempSync(join(scratch, 'profile-'));
    try {
      // Written AFTER the wait began, as a starting browser writes it: on the wait's first look
      // that found nothing (its `exited` check), synchronously, so the next look is the one to see
      // it — an event, not a 60 ms guess.
      let looks = 0;
      const connection = await portConnection({
        profileDir,
        exited: () => {
          looks += 1;
          if (looks === 1) {
            writeFileSync(
              join(profileDir, DEVTOOLS_ACTIVE_PORT),
              `${String(server.port)}\n/devtools/browser/stand-in\n`,
            );
          }
          return false;
        },
        deadlineMs: 5_000,
        timeoutMs: 5_000,
      });
      const reply = await connection.send('Browser.getVersion');
      expect(reply).toEqual({ result: { product: 'StandIn' } });
      // It waited: one look found nothing, the next found the announcement.
      expect(looks).toBe(1);
      connection.close();
    } finally {
      await server.stop(true);
    }
  });

  test('a browser that exits before announcing is a CLOSED launch, at once', async () => {
    const profileDir = mkdtempSync(join(scratch, 'profile-'));
    const error = await portConnection({
      profileDir,
      exited: () => true,
      deadlineMs: 5_000,
      timeoutMs: 5_000,
    }).catch((e: unknown) => e);
    expect(error).toBeUltimateError('X_CDP_CALL_FAILED');
  });

  test('a browser that never announces is a TIMED-OUT launch at the deadline', async () => {
    const profileDir = mkdtempSync(join(scratch, 'profile-'));
    const started = performance.now();
    const error = await portConnection({
      profileDir,
      exited: () => false,
      deadlineMs: 150,
      timeoutMs: 5_000,
    }).catch((e: unknown) => e);
    expect(error).toBeUltimateError('X_CDP_TIMEOUT');
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  // Windows CI, PR #668: Chrome had printed "DevTools listening", the file EXISTED, and the read
  // threw `EBUSY: resource busy or locked` because Chrome still held it open for its write. That
  // throw left the poll as a "closed" launch with the browser alive. A file its writer still holds
  // is a file not written yet — the same answer a half-written one gets.
  test('a file the browser still holds open (EBUSY) is not announced yet, and the wait goes on', async () => {
    const server = standIn();
    const profileDir = mkdtempSync(join(scratch, 'profile-'));
    const path = join(profileDir, DEVTOOLS_ACTIVE_PORT);
    await Bun.write(path, `${String(server.port)}\n/devtools/browser/stand-in\n`);
    let reads = 0;
    try {
      const connection = await portConnection({
        profileDir,
        exited: () => false,
        deadlineMs: 5_000,
        timeoutMs: 5_000,
        readText: async (file) => {
          reads += 1;
          if (reads <= 3) throw busy(file);
          return await Bun.file(file).text();
        },
      });
      expect(reads).toBe(4);
      expect(await connection.send('Browser.getVersion')).toEqual({
        result: { product: 'StandIn' },
      });
      connection.close();
    } finally {
      await server.stop(true);
    }
  });

  // windows CI, run 42978963381: "DevTools listening" on stderr, the port announced, and the launch
  // failed `"connect" did not answer inside 10000ms` with 50 s of its 60 s deadline left. The dial
  // was bounded by the PER-CALL deadline (`timeoutMs`), not the launch's: a cold Chrome that had
  // bound its port but not yet answered the WebSocket upgrade was given up on as dead. Held here
  // by a stand-in that answers the upgrade only after the per-call deadline has passed.
  describe('the dial is bounded by the LAUNCH deadline, never the per-call one', () => {
    const held = () => {
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let dialled: () => void = () => undefined;
      const arrived = new Promise<void>((resolve) => {
        dialled = resolve;
      });
      const server = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        fetch: async (request, srv) => {
          dialled();
          await gate;
          return srv.upgrade(request) ? undefined : new Response('upgrade', { status: 426 });
        },
        websocket: {
          message(socket, raw) {
            const { id } = JSON.parse(String(raw)) as { id: number };
            socket.send(JSON.stringify({ id, result: { product: 'StandIn' } }));
          },
        },
      });
      return { server, release, arrived };
    };

    test('an upgrade slower than timeoutMs but inside deadlineMs connects', async () => {
      const { server, release, arrived } = held();
      const profileDir = mkdtempSync(join(scratch, 'profile-'));
      await Bun.write(
        join(profileDir, DEVTOOLS_ACTIVE_PORT),
        `${String(server.port)}\n/devtools/browser/stand-in\n`,
      );
      jest.useFakeTimers();
      try {
        const dial = portConnection({
          profileDir,
          exited: () => false,
          deadlineMs: 60_000,
          timeoutMs: 100,
        }).then(
          (connection) => ({ connection }),
          (error: unknown) => ({ error }),
        );
        await arrived;
        // Ten per-call deadlines pass with the upgrade still unanswered: a dial bounded by
        // `timeoutMs` has given up by now.
        jest.advanceTimersByTime(1_000);
        release();
        const settled = await dial;
        if (!('connection' in settled)) {
          expect.unreachable(
            `the dial gave up inside the launch deadline: ${String(settled.error)}`,
          );
        }
        jest.useRealTimers();
        expect(await settled.connection.send('Browser.getVersion')).toEqual({
          result: { product: 'StandIn' },
        });
        settled.connection.close();
      } finally {
        jest.useRealTimers();
        release();
        await server.stop(true);
      }
    });

    test('an upgrade still unanswered at deadlineMs is a TIMED-OUT launch', async () => {
      const { server, release, arrived } = held();
      const profileDir = mkdtempSync(join(scratch, 'profile-'));
      await Bun.write(
        join(profileDir, DEVTOOLS_ACTIVE_PORT),
        `${String(server.port)}\n/devtools/browser/stand-in\n`,
      );
      jest.useFakeTimers();
      try {
        const dial = portConnection({
          profileDir,
          exited: () => false,
          deadlineMs: 2_000,
          timeoutMs: 60_000,
        }).catch((e: unknown) => e);
        await arrived;
        jest.advanceTimersByTime(2_001);
        const error = await dial;
        expect(error).toBeUltimateError('X_CDP_TIMEOUT');
        expect((error as { cause: string }).cause).toContain('"connect"');
      } finally {
        jest.useRealTimers();
        release();
        await server.stop(true);
      }
    });
  });

  // Only the two codes that mean "not there yet": anything else is the launch failing, by name.
  test('any other read failure still ends the wait, naming it', async () => {
    const profileDir = mkdtempSync(join(scratch, 'profile-'));
    await Bun.write(join(profileDir, DEVTOOLS_ACTIVE_PORT), 'x');
    const error = await portConnection({
      profileDir,
      exited: () => false,
      deadlineMs: 5_000,
      timeoutMs: 5_000,
      readText: async () => {
        throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      },
    }).catch((e: unknown) => e);
    expect(String((error as { message?: unknown }).message)).toContain('EACCES');
  });
});

/** The error Bun raises on Windows for a file another process holds open without read sharing. */
function busy(path: string): Error {
  return Object.assign(new Error(`EBUSY: resource busy or locked, open '${path}'`), {
    code: 'EBUSY',
  });
}
