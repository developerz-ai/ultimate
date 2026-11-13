// `timeBoot`'s refusals that must never leave a process behind or time the wrong server: a body
// that breaks while it is read, a port something else already answers on, and a 200 seen after
// the child exited.

import { afterAll, describe, expect, test } from 'bun:test';
// why: Bun ships no temp directory or recursive delete of its own.
import { mkdtemp, rm } from 'node:fs/promises';
// why: as above — the platform temp root is only node:os's to name.
import { tmpdir } from 'node:os';
import { allowHost } from '../../packages/testing/src/sealed-network';
import { ScriptError } from '../lib/script-error';
import { readiness, timeBoot } from './boot-large-app-proc';

const scratch: string[] = [];
afterAll(async () => {
  for (const dir of scratch) await rm(dir, { recursive: true, force: true });
});

const codeOf = async (work: () => Promise<unknown>): Promise<string | undefined> =>
  work().then(
    () => undefined,
    (error: unknown) => (error instanceof ScriptError ? error.code : 'not a ScriptError'),
  );

/** Whether `pid` is still a live process. */
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function scratchDir(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(`${tmpdir()}/boot-proc-`);
  scratch.push(dir);
  for (const [name, source] of Object.entries(files)) await Bun.write(`${dir}/${name}`, source);
  return dir;
}

/**
 * A port the kernel handed out, for a child this file spawns: the parent must name the port to the
 * seal before the child binds it, so it asks first — serve port 0, read what came back, stop,
 * pass it on through the child's argv.
 */
async function freePort(): Promise<number> {
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response() });
  const { port } = server;
  await server.stop(true);
  // `Server.port` is `number | undefined` — a unix-socket server has none. This one is TCP.
  // Narrow, not `??`: over `expect.unreachable`'s `never`, TS 7 keeps the undefined.
  if (port === undefined) {
    return expect.unreachable('Bun.serve({ port: 0 }) opened no TCP port');
  }
  return port;
}

describe('timeBoot never leaves a process or times a stranger', () => {
  test('a 200 whose body never ends is not ready, and the group is still reaped', async () => {
    // Writes its pid, then answers 200 and sends one byte of a body it never finishes: the read
    // aborts on the poll's own timeout, after the headers said 200.
    const port = await freePort();
    // A bare `Bun.serve` announces nothing, so the seal is told this port and no other.
    allowHost(`127.0.0.1:${String(port)}`);
    const dir = await scratchDir({
      'server.ts': `
const port = Number(Bun.argv[2]);
await Bun.write('pid', String(process.pid));
Bun.serve({ port, hostname: '127.0.0.1', fetch: () => new Response(new ReadableStream({
  start(controller) { controller.enqueue(new TextEncoder().encode('x')); },
}), { status: 200 }) });
`,
    });
    const code = await codeOf(() =>
      timeBoot({
        cmd: ['bun', 'server.ts', String(port)],
        cwd: dir,
        env: { PATH: Bun.env['PATH'] },
        url: `http://127.0.0.1:${port}/`,
        timeoutMs: 2_000,
      }),
    );
    expect(code).toBe('X_BENCH_RUN_FAILED');
    const pid = Number(await Bun.file(`${dir}/pid`).text());
    expect(alive(pid)).toBe(false);
  }, 40_000);

  test('a port something already answers 200 on is refused before anything spawns', async () => {
    const stranger = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response() });
    const port = stranger.port;
    // A bare `Bun.serve` announces nothing, so the seal is told this port and no other.
    allowHost(`127.0.0.1:${String(port)}`);
    try {
      const dir = await scratchDir({ 'boot.ts': "await Bun.write('spawned', 'yes');\n" });
      const code = await codeOf(() =>
        timeBoot({
          cmd: ['bun', 'boot.ts'],
          cwd: dir,
          env: { PATH: Bun.env['PATH'] },
          url: `http://127.0.0.1:${port}/`,
          timeoutMs: 2_000,
        }),
      );
      expect(code).toBe('X_BENCH_RUN_FAILED');
      expect(await Bun.file(`${dir}/spawned`).exists()).toBe(false);
    } finally {
      await stranger.stop(true);
    }
  }, 40_000);

  test('a 200 counts only while the child is alive: an exited child is never the answer', () => {
    expect(readiness(200, null)).toBe('ready');
    expect(readiness(200, 0)).toBe('exited');
    expect(readiness(503, 1)).toBe('exited');
    expect(readiness(503, null)).toBe('waiting');
  });
});
