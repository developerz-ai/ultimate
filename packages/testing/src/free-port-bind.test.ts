// `bindFreePorts` against a scripted OS and the real one: a lost race is asked again on fresh
// ports, anything else is the caller's failure at once, and the last clash is never swallowed.

import { describe, expect, test } from 'bun:test';
import type { PortProbe } from './free-port';
import { bindFreePorts, isPortClash, PORT_BIND_ATTEMPTS } from './free-port-bind';

/** A listener that answers `ports` in order, each released on `stop`. */
const scripted = (ports: readonly number[]) => {
  let next = 0;
  return (): PortProbe => {
    const port =
      ports[next] ?? expect.unreachable('bindFreePorts asked for more ports than scripted');
    next += 1;
    return { port, stop: () => undefined };
  };
};

/** What Bun throws for a listener on a held port, taken from Bun itself rather than retyped. */
const realClash = (): unknown => {
  const holder = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response() });
  try {
    Bun.serve({ port: holder.port ?? 0, hostname: '127.0.0.1', fetch: () => new Response() }).stop(
      true,
    );
    return expect.unreachable('a second listener bound a held port');
  } catch (error) {
    return error;
  } finally {
    holder.stop(true);
  }
};

describe('isPortClash', () => {
  test('Bun’s own refusal, the CLI’s code and a child’s printed output are clashes', () => {
    expect(isPortClash(realClash())).toBe(true);
    expect(isPortClash({ code: 'X_PORT_IN_USE', cause: 'taken' })).toBe(true);
    expect(isPortClash('error: Failed to start server. Is port 41234 in use?\n')).toBe(true);
    expect(isPortClash('{"code":"X_PORT_IN_USE","cause":"the dev port is taken"}')).toBe(true);
    expect(isPortClash({ code: 'X_E2E_APP_FAILED', cause: '… code: "EADDRINUSE" …' })).toBe(true);
  });

  test('anything else is not, so it reaches the caller at once', () => {
    expect(isPortClash({ code: 'X_DB_UNAVAILABLE', cause: 'refused' })).toBe(false);
    expect(isPortClash('ultimate started')).toBe(false);
    expect(isPortClash(undefined)).toBe(false);
    expect(isPortClash(7)).toBe(false);
  });
});

describe('bindFreePorts', () => {
  test('a lost race is asked again, on ports no earlier attempt was handed', async () => {
    // The OS answers 40001 again on the second ask: it was released, and is the OS's to re-hand.
    const listen = scripted([40_001, 40_002, 40_001, 40_003, 40_004]);
    const handed: (readonly number[])[] = [];
    const bound = await bindFreePorts(
      (ports) => {
        handed.push(ports);
        if (handed.length === 1)
          throw Object.assign(new TypeError('taken'), { code: 'EADDRINUSE' });
        return 'bound';
      },
      { count: 2, listen },
    );
    expect(bound).toBe('bound');
    expect(handed).toEqual([
      [40_001, 40_002],
      [40_003, 40_004],
    ]);
  });

  test('a failure that is no clash is rethrown on the first attempt', async () => {
    let calls = 0;
    const failure = { code: 'X_DB_UNAVAILABLE', cause: 'refused' };
    const outcome = await bindFreePorts(
      () => {
        calls += 1;
        throw failure;
      },
      { listen: scripted([40_001]) },
    ).catch((error: unknown) => error);
    expect(outcome).toBe(failure);
    expect(calls).toBe(1);
  });

  test('the last clash is rethrown as it was, after the bounded attempts', async () => {
    let calls = 0;
    const outcome = await bindFreePorts(
      (ports) => {
        calls += 1;
        throw { code: 'X_PORT_IN_USE', cause: `port ${String(ports[0])} is taken` };
      },
      { listen: scripted([40_001, 40_002, 40_003, 40_004, 40_005]) },
    ).catch((error: unknown) => error);
    expect(calls).toBe(PORT_BIND_ATTEMPTS);
    expect(outcome).toEqual({ code: 'X_PORT_IN_USE', cause: 'port 40005 is taken' });
  });

  test('against the real OS, a port taken between the ask and the bind is won on the next', async () => {
    let thief: ReturnType<typeof Bun.serve> | undefined;
    const server = await bindFreePorts(([port = 0]) => {
      // Another process takes the first port the instant it was handed out: the race itself.
      if (thief === undefined) {
        thief = Bun.serve({ port, hostname: '127.0.0.1', fetch: () => new Response() });
      }
      return Bun.serve({ port, hostname: '127.0.0.1', fetch: () => new Response() });
    });
    try {
      expect(server.port).not.toBe(thief?.port);
    } finally {
      server.stop(true);
      thief?.stop(true);
    }
  });

  test('a pair hands out a port whose neighbour binds too', async () => {
    const [web, sync] = await bindFreePorts(
      ([port = 0]) => [
        Bun.serve({ port, hostname: '127.0.0.1', fetch: () => new Response() }),
        Bun.serve({ port: port + 1, hostname: '127.0.0.1', fetch: () => new Response() }),
      ],
      { pair: true },
    );
    expect(sync?.port).toBe((web?.port ?? 0) + 1);
    web?.stop(true);
    sync?.stop(true);
  });
});
