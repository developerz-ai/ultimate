import { afterEach, describe, expect, test } from 'bun:test';
import { markListening, resetListeners } from '@ultimat3/core';
import {
  allowHost,
  mockJson,
  requestedUrls,
  resetNetwork,
  sealNetwork,
  setNetworkState,
  unsealNetwork,
} from './sealed-network';
import { testName } from './test-types';

sealNetwork();

afterEach(() => {
  resetNetwork();
  resetListeners();
});

/** The seal throws; anything else means the request left this file. Never resolves to a Response. */
const refusalOf = async (url: string): Promise<{ code?: string } | undefined> =>
  fetch(url).then(
    () => undefined,
    (error: unknown) => error as { code?: string },
  );

describe(testName('unit', 'sealed network'), () => {
  test('an unmocked request fails with the URL and the line that fixes it', async () => {
    try {
      await fetch('https://api.stripe.com/v1/charges', { method: 'POST' });
      throw new Error('expected the sealed network to refuse this');
    } catch (error) {
      const failure = error as { code?: string; cause?: string; fix?: string };
      expect(failure.code).toBe('X_TEST_NETWORK_SEALED');
      expect(failure.cause).toContain('POST https://api.stripe.com/v1/charges');
      expect(failure.fix).toContain("mockFetch('https://api.stripe.com/v1/charges'");
      expect(failure.fix).toContain("allowHost('api.stripe.com')");
    }
  });

  test('a mocked request is answered without touching the network', async () => {
    mockJson('https://api.stripe.com/v1/charges', { id: 'ch_1' });
    const response = await fetch('https://api.stripe.com/v1/charges', { method: 'POST' });
    expect(await response.json()).toEqual({ id: 'ch_1' });
  });

  test('a prefix mock covers a whole path', async () => {
    mockJson('https://api.example.com/*', { ok: true });
    expect(await (await fetch('https://api.example.com/a/b/c')).json()).toEqual({ ok: true });
  });

  test('a regexp mock matches on the whole URL', async () => {
    mockJson(/\/v1\/customers\/[a-z0-9]+$/, { id: 'cus_1' });
    expect(await (await fetch('https://api.example.com/v1/customers/abc')).json()).toEqual({
      id: 'cus_1',
    });
  });

  test('the failure names the hosts that are allowed, so the fix is obvious', async () => {
    allowHost('allowed.example.com');
    try {
      await fetch('https://blocked.example.com/x');
      throw new Error('expected a refusal');
    } catch (error) {
      expect((error as { cause?: string }).cause).toContain('allowed.example.com');
    }
  });

  test('a port this process opened is not egress — the seal lets it through', async () => {
    const release = markListening('http://127.0.0.1:59321');
    // Nothing is listening, so this must fail — but as a connection error, not as the seal.
    expect((await refusalOf('http://localhost:59321/healthz'))?.code).not.toBe(
      'X_TEST_NETWORK_SEALED',
    );
    release();
    expect((await refusalOf('http://localhost:59321/healthz'))?.code).toBe('X_TEST_NETWORK_SEALED');
  });

  test('every attempted URL is recorded, in order', async () => {
    mockJson('https://a.example.com/1', {});
    mockJson('https://a.example.com/2', {});
    await fetch('https://a.example.com/1');
    await fetch('https://a.example.com/2');
    expect(requestedUrls()).toEqual(['https://a.example.com/1', 'https://a.example.com/2']);
  });

  test('a global or sticky regexp mock matches EVERY call, not every other one', async () => {
    // `RegExp.prototype.test` on a `g`/`y` pattern resumes at `lastIndex`, so the second call
    // missed the mock and reached the seal.
    mockJson(/api\.example\.com\/g/g, { ok: 'g' });
    mockJson(/^https:\/\/api\.example\.com\/y/y, { ok: 'y' });
    for (const _ of [1, 2, 3]) {
      expect(await (await fetch('https://api.example.com/g')).json()).toEqual({ ok: 'g' });
      expect(await (await fetch('https://api.example.com/y')).json()).toEqual({ ok: 'y' });
    }
  });
});

/** What a sealed socket dial threw or rejected with — `undefined` when it went through. */
const socketRefusal = async (dial: () => unknown): Promise<{ code?: string } | undefined> => {
  try {
    await dial();
    return undefined;
  } catch (error) {
    return error as { code?: string };
  }
};

/** A dial that must never connect: `example.invalid` is reserved (RFC 6761), resolves nowhere. */
const dialInvalid = (): Promise<unknown> =>
  Bun.connect({ hostname: 'example.invalid', port: 443, socket: { data() {} } });

describe(testName('unit', 'sealed network — sockets, not only fetch'), () => {
  test('new WebSocket to a host nobody allowed is X_TEST_NETWORK_SEALED, before any dial', () => {
    let refusal: { code?: string; cause?: string; fix?: string } | undefined;
    try {
      new WebSocket('ws://example.invalid').close();
    } catch (error) {
      refusal = error as { code?: string; cause?: string; fix?: string };
    }
    expect(refusal?.code).toBe('X_TEST_NETWORK_SEALED');
    expect(refusal?.cause).toContain('WEBSOCKET ws://example.invalid');
    expect(refusal?.fix).toContain("allowHost('example.invalid')");
    // A socket has no mock: the repair is the transport the code under test already takes.
    expect(refusal?.fix).not.toContain('mockFetch');
    expect(refusal?.fix).toContain('inject the transport');
    expect(requestedUrls()).toEqual(['ws://example.invalid']);
  });

  test('Bun.connect to a host nobody allowed rejects X_TEST_NETWORK_SEALED', async () => {
    const refusal = (await socketRefusal(dialInvalid)) as {
      code?: string;
      cause?: string;
      fix?: string;
    };
    expect(refusal?.code).toBe('X_TEST_NETWORK_SEALED');
    expect(refusal?.cause).toContain('CONNECT tcp://example.invalid:443');
    expect(refusal?.fix).not.toContain('mockFetch');
    expect(refusal?.fix).toContain("allowHost('example.invalid:443')");
  });

  test('offline closes sockets too, with the offline code rather than the seal', async () => {
    setNetworkState('offline');
    expect((await socketRefusal(() => new WebSocket('wss://example.invalid')))?.code).toBe(
      'X_TEST_NETWORK_OFFLINE',
    );
    expect((await socketRefusal(dialInvalid))?.code).toBe('X_TEST_NETWORK_OFFLINE');
  });

  test('offline closes a loopback socket too, the same order fetch checks in', async () => {
    // Offline first, loopback second — as `fetch` does. A loopback pass ahead of the offline
    // check let `new WebSocket('ws://localhost:1')` through while `fetch` to the same host threw.
    setNetworkState('offline');
    expect((await socketRefusal(() => new WebSocket('ws://localhost:1')))?.code).toBe(
      'X_TEST_NETWORK_OFFLINE',
    );
    const dialLoopback = () =>
      Bun.connect({ hostname: '127.0.0.1', port: 1, socket: { data() {} } });
    expect((await socketRefusal(dialLoopback))?.code).toBe('X_TEST_NETWORK_OFFLINE');
    expect((await refusalOf('http://localhost:1/'))?.code).toBe('X_TEST_NETWORK_OFFLINE');
  });

  test('loopback is this machine, not egress: a Bun.listen server is reachable', async () => {
    const server = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
    try {
      const socket = await Bun.connect({
        hostname: '127.0.0.1',
        port: server.port,
        socket: { data() {} },
      });
      socket.end();
      const ws = new WebSocket(`ws://localhost:${server.port}/`);
      ws.close();
    } finally {
      server.stop(true);
    }
  });

  test('an allowed host reaches the REAL dial, and unseal hands the originals back', async () => {
    const realWebSocket = globalThis.WebSocket;
    const realConnect = Bun.connect;
    const dialled: string[] = [];
    class FakeWebSocket extends EventTarget {
      constructor(url: string | URL) {
        super();
        dialled.push(String(url));
      }
    }
    const fakeConnect = (options: { readonly hostname?: string }): Promise<string> => {
      dialled.push(`tcp ${options.hostname}`);
      return Promise.resolve('connected');
    };
    unsealNetwork();
    Reflect.set(globalThis, 'WebSocket', FakeWebSocket);
    Reflect.set(Bun, 'connect', fakeConnect);
    try {
      sealNetwork();
      allowHost('example.invalid');
      allowHost('example.invalid:443');
      new WebSocket('ws://example.invalid');
      expect(await dialInvalid()).toBe('connected');
      expect(dialled).toEqual(['ws://example.invalid', 'tcp example.invalid']);
      unsealNetwork();
      expect(globalThis.WebSocket).toBe(FakeWebSocket as unknown as typeof WebSocket);
      expect(Bun.connect).toBe(fakeConnect as unknown as typeof Bun.connect);
    } finally {
      unsealNetwork();
      Reflect.set(globalThis, 'WebSocket', realWebSocket);
      Reflect.set(Bun, 'connect', realConnect);
      sealNetwork();
    }
  });
});
