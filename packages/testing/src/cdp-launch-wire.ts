// One responsibility: the WIRE a launched Chrome is driven over, per platform — its debugging pipe
// (fds 3 and 4) where the parent can hold those fds, else a loopback port the browser picks and
// announces in its profile's `DevToolsActivePort`. Spawning and reaping are `cdp-launch-attempt.ts`.

// why: Bun exposes no path-join primitive; the announcement file lives in the profile directory.
import { join } from 'node:path';
import type { CdpConnection } from './cdp-connection';
import { cdpConnect, cdpConnectOver } from './cdp-connection';
import { CdpCallFailedError, CdpTimeoutError } from './cdp-errors';
import { pipeTransport } from './cdp-pipe';

/**
 * `pipe` everywhere Bun hands the parent the child's extra fds as descriptors, which is POSIX: no
 * port, so two suites on one machine never collide and nothing else can drive the browser.
 * `port` on Windows, where those fds are not descriptors `Bun.file` can open: Chrome binds a
 * loopback port of its own choosing (`=0`, so never a collision either) and writes it down.
 */
export type CdpWire = 'pipe' | 'port';

export const defaultWire = (platform: string): CdpWire => (platform === 'win32' ? 'port' : 'pipe');

/** The one flag that differs between the two wires. */
export const wireFlag = (wire: CdpWire): string =>
  wire === 'pipe' ? '--remote-debugging-pipe' : '--remote-debugging-port=0';

/** Chrome's fd 3 is where it READS commands and fd 4 where it WRITES replies — pipe wire only. */
const PIPE_STDIO = ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] as const;
const PORT_STDIO = ['ignore', 'ignore', 'pipe'] as const;
export const wireStdio = (wire: CdpWire): typeof PIPE_STDIO | typeof PORT_STDIO =>
  wire === 'pipe' ? PIPE_STDIO : PORT_STDIO;

/** The pipe wire over a spawned child's fds 3 and 4. Answers nothing until the first `send`. */
export function pipeConnection(stdio: unknown, timeoutMs: number): CdpConnection {
  const [, , , toBrowser, fromBrowser] = stdio as readonly number[];
  const sink = Bun.file(toBrowser ?? -1).writer();
  return cdpConnectOver(
    pipeTransport({
      write: (bytes) => {
        sink.write(bytes);
        void sink.flush();
      },
      read: Bun.file(fromBrowser ?? -1).stream(),
      end: () => {
        void Promise.resolve(sink.end()).catch(() => undefined);
      },
    }),
    timeoutMs,
  );
}

export const DEVTOOLS_ACTIVE_PORT = 'DevToolsActivePort';

/**
 * `<port>\n/devtools/browser/<id>\n` → the browser's WebSocket url, or `undefined` while the file is
 * still half-written. Loopback by address, never `localhost`, which may resolve to `::1` first
 * while Chrome listens on IPv4.
 */
export function devToolsEndpoint(text: string): string | undefined {
  const [port, path] = text.split(/\r?\n/);
  if (port === undefined || !/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65_535) {
    return undefined;
  }
  if (path === undefined || !/^\/devtools\/browser\/[\w-]+$/.test(path)) return undefined;
  return `ws://127.0.0.1:${port}${path}`;
}

const ANNOUNCE_POLL_MS = 25;

/**
 * Dial, inside what is left of the LAUNCH deadline — `cdpConnect`'s own deadline is the per-call one
 * the connection keeps afterwards, so it cannot also be the launch's. A dial that loses the race
 * and connects later is closed, never left holding a socket nobody reads.
 */
async function dialWithin(
  endpoint: string,
  leftMs: number,
  timeoutMs: number,
): Promise<CdpConnection> {
  const dialing = cdpConnect({ endpoint, timeoutMs });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new CdpTimeoutError({ method: 'connect', timeoutMs: leftMs })),
      leftMs,
    );
  });
  try {
    return await Promise.race([dialing, late]);
  } catch (error) {
    void dialing.then((connection) => connection.close()).catch(() => undefined);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export interface PortConnectionInput {
  readonly profileDir: string;
  /** True once the browser process has exited — it will never write the file then. */
  readonly exited: () => boolean;
  /** How long the browser has to announce itself AND accept the connection, from now. */
  readonly deadlineMs: number;
  /** Every call's deadline once connected. */
  readonly timeoutMs: number;
}

/**
 * The port wire: wait for the profile's `DevToolsActivePort`, then dial it. A browser that exits
 * first is a CLOSED launch and one still silent at the deadline a TIMED-OUT one — the same two
 * answers the pipe gives, so the launcher's failure report reads alike on either wire.
 */
export async function portConnection(input: PortConnectionInput): Promise<CdpConnection> {
  const path = join(input.profileDir, DEVTOOLS_ACTIVE_PORT);
  const began = performance.now();
  for (;;) {
    // A FRESH handle per look: a `BunFile` that once answered "absent" keeps answering it (measured
    // on Bun 1.4.2 — `exists()` false and `text()` empty after the file was written).
    const file = Bun.file(path);
    const endpoint = (await file.exists()) ? devToolsEndpoint(await file.text()) : undefined;
    const left = input.deadlineMs - (performance.now() - began);
    if (endpoint !== undefined) return dialWithin(endpoint, Math.max(1, left), input.timeoutMs);
    if (input.exited()) {
      throw new CdpCallFailedError({
        method: 'the launch',
        detail: `the browser exited before it wrote ${DEVTOOLS_ACTIVE_PORT}`,
      });
    }
    if (left <= 0) {
      throw new CdpTimeoutError({ method: DEVTOOLS_ACTIVE_PORT, timeoutMs: input.deadlineMs });
    }
    await Bun.sleep(Math.min(ANNOUNCE_POLL_MS, left));
  }
}
