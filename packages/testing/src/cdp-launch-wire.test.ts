// The port wire, end to end against an in-process DevTools stand-in: the browser's announcement
// file, the dial, a reply. Nothing here spawns, so it runs alike on Windows — where this wire is
// the default — and on the Linux runner.

import { afterAll, describe, expect, test } from 'bun:test';
// why: Bun exposes no temp-directory primitive and no recursive remove.
import { mkdtempSync, rmSync } from 'node:fs';
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
      // Written AFTER the wait began, as a starting browser writes it.
      setTimeout(() => {
        void Bun.write(
          join(profileDir, DEVTOOLS_ACTIVE_PORT),
          `${String(server.port)}\n/devtools/browser/stand-in\n`,
        );
      }, 60);
      const connection = await portConnection({
        profileDir,
        exited: () => false,
        deadlineMs: 5_000,
        timeoutMs: 5_000,
      });
      const reply = await connection.send('Browser.getVersion');
      expect(reply).toEqual({ result: { product: 'StandIn' } });
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
});
