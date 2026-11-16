// `scaffold-admin`'s port handling: an `x dev` that died on a port another process held is booted
// again on the next one — read off its whole output, however long the log after the refusal — and
// a boot whose every port was taken is a refusal, never a throw. No server is booted here.

import { afterAll, describe, expect, test } from 'bun:test';
import { checkAdmin, fixedPort, freeDevPorts, portTaken } from './scaffold-admin';
import { appDir, fakeApp, fakeIo as io, trees } from './scaffold-admin-fixture';

afterAll(() => trees.dispose());

describe('unit · the command, when its port was taken', () => {
  test('an x dev that died on a held port is booted again on the next one, and walked there', async () => {
    const dir = await appDir(['manifest', 'actor', 'bin']);
    const app = fakeApp();
    const { made, calls } = io(app.fetcher);
    let stops = 0;
    const result = await checkAdmin(dir, {
      ...made,
      // The first boot dies at once printing the CLI's own refusal; the second one serves.
      boot: (bootDir, port) => {
        const server = made.boot(bootDir, port);
        if (port !== 4000) return server;
        return {
          exited: () => true,
          stop: async () => {
            stops += 1;
            await server.stop();
            return 'X_PORT_IN_USE: the dev port is taken';
          },
        };
      },
      ports: (bind) =>
        bind(4000).catch((error: unknown) => {
          expect(String((error as { cause?: unknown }).cause)).toContain('X_PORT_IN_USE');
          return bind(4002);
        }),
    });
    expect(result.ok).toBe(true);
    expect(calls.booted.map(([, port]) => port)).toEqual([4000, 4002]);
    expect(stops).toBe(1);
  });

  test('a clash followed by a long shutdown log is still a clash: the real binder boots again', async () => {
    const dir = await appDir(['manifest', 'actor', 'bin']);
    const app = fakeApp();
    const { made } = io(app.fetcher);
    const booted: number[] = [];
    // The refusal first, then more lines than any cause keeps: a stack, the drain's own log.
    const tail = Array.from({ length: 20 }, (_, n) => `shutdown line ${String(n)}`).join('\n');
    const result = await checkAdmin(dir, {
      ...made,
      boot: (bootDir, port) => {
        booted.push(port);
        if (booted.length > 1) return made.boot(bootDir, port);
        return { exited: () => true, stop: async () => `X_PORT_IN_USE: taken\n${tail}` };
      },
      ports: freeDevPorts,
    });
    expect(result.ok).toBe(true);
    expect(booted).toHaveLength(2);
  });

  test('a boot whose every port was taken is refused with what it printed, never thrown', async () => {
    const dir = await appDir(['manifest', 'actor', 'bin']);
    const { made } = io(fakeApp().fetcher);
    const result = await checkAdmin(dir, {
      ...made,
      boot: () => ({ exited: () => true, stop: async () => 'X_PORT_IN_USE: taken' }),
    });
    expect(result.ok).toBe(false);
    expect(result.findings?.[0]?.cause).toContain('met a port another process held');
    expect(result.findings?.[0]?.fix).toContain('bun run dev --port 4000');
  });
});

describe('the port binder', () => {
  test('a pair is bound by the boot itself, and its neighbour binds too', async () => {
    const [web, sync] = await freeDevPorts(async (port) => [
      Bun.serve({ port, hostname: '127.0.0.1', fetch: () => new Response() }),
      Bun.serve({ port: port + 1, hostname: '127.0.0.1', fetch: () => new Response() }),
    ]);
    expect(sync?.port).toBe((web?.port ?? 0) + 1);
    web?.stop(true);
    sync?.stop(true);
  });

  test('a boot that met a held port is booted again on a fresh one', async () => {
    const tried: number[] = [];
    const port = await freeDevPorts(async (candidate) => {
      tried.push(candidate);
      if (tried.length === 1) {
        throw portTaken(candidate, 'X_PORT_IN_USE: the dev port is taken', 'x dev --port 0');
      }
      return candidate;
    });
    expect(tried).toHaveLength(2);
    expect(port).not.toBe(tried[0]);
  });

  test('a fixed port is handed as it is, for a fake x dev that binds nothing', async () => {
    expect(await fixedPort(4000)(async (port) => port)).toBe(4000);
  });
});
