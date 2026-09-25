// The raw-CDP shot driver against a fake WIRE, not a fake page: every call goes through the real
// `cdpConnectOver` framing, so what is asserted is the CDP a real browser would receive. A real
// Chrome drives the same code in `e2e/cdp-shot.e2e.test.ts`.
import { describe, expect, test } from 'bun:test';
import type { CdpTransport } from '@ultimat3/testing';
import { cdpConnectOver } from '@ultimat3/testing';
import type { ShotClock, ShotSessionInit } from './browser-launcher-port';
import { cdpShotDriver } from './cdp-shot-driver';

interface Call {
  readonly method: string;
  readonly params: Record<string, unknown>;
  readonly sessionId?: string | undefined;
}

type Answer = (call: Call) => Record<string, unknown> | undefined;

/** One browser on the other end of a transport: answers by method, emits events on demand. */
function fakeWire(answer: Answer = () => undefined) {
  let handlers: Parameters<CdpTransport['listen']>[0] | undefined;
  const calls: Call[] = [];
  const transport: CdpTransport = {
    send(text) {
      const frame = JSON.parse(text) as Call & { id: number };
      calls.push({ method: frame.method, params: frame.params, sessionId: frame.sessionId });
      queueMicrotask(() =>
        handlers?.message(JSON.stringify({ id: frame.id, result: answer(frame) ?? {} })),
      );
    },
    close: () => undefined,
    listen(next) {
      handlers = next;
    },
  };
  const connection = cdpConnectOver(transport, 1_000);
  return {
    connection,
    calls,
    emit(method: string, params: Record<string, unknown>, sessionId = 'S1') {
      handlers?.message(JSON.stringify({ method, params, sessionId }));
    },
    methods: (): string[] => calls.map((call) => call.method),
  };
}

/** Sleeping IS advancing: a 30-second deadline finishes in microseconds. */
const testClock = (): ShotClock => {
  let mono = 0;
  return {
    now: () => new Date(1_700_000_000_000 + mono),
    monotonic: () => mono,
    sleep: async (ms) => {
      mono += ms;
      await Promise.resolve();
    },
  };
};

const init = (overrides: Partial<ShotSessionInit> = {}): ShotSessionInit => ({
  name: 'x shot',
  rules: { allowHosts: ['localhost'] },
  clock: testClock(),
  timeoutMs: 1_000,
  ...overrides,
});

const attach: Answer = (call) => {
  if (call.method === 'Target.createTarget') return { targetId: 'T1' };
  if (call.method === 'Target.attachToTarget') return { sessionId: 'S1' };
  return undefined;
};

const evaluating =
  (values: (expression: string) => unknown): Answer =>
  (call) =>
    call.method === 'Runtime.evaluate'
      ? { result: { value: values(String(call.params['expression'])) } }
      : attach(call);

const opened = async (answer: Answer = attach, overrides: Partial<ShotSessionInit> = {}) => {
  const wire = fakeWire(answer);
  let closed = 0;
  const driver = cdpShotDriver({
    executablePath: '/usr/bin/chrome',
    launch: async () => ({
      connection: wire.connection,
      close: () => {
        closed += 1;
      },
    }),
  });
  const session = await driver.open(init(overrides));
  return { wire, session, page: session.page, closedCount: () => closed };
};

const element = (over: Record<string, unknown> = {}) =>
  JSON.stringify([
    {
      tag: 'button',
      attrs: [['id', 'go']],
      text: 'Go',
      value: '',
      visible: true,
      enabled: true,
      box: { x: 10, y: 20, width: 100, height: 40 },
      hitTarget: true,
      ...over,
    },
  ]);

describe('unit · a session is one page, configured before it loads anything', () => {
  test('attaches, turns the domains on and sizes the viewport, in that order', async () => {
    const { wire } = await opened();
    expect(wire.methods()).toEqual([
      'Target.createTarget',
      'Target.attachToTarget',
      'Runtime.enable',
      'Page.enable',
      'Network.enable',
      'Fetch.enable',
      'Emulation.setDeviceMetricsOverride',
    ]);
    expect(wire.calls.at(-1)?.params).toMatchObject({ width: 800, height: 600 });
    expect(wire.calls.at(-1)?.sessionId).toBe('S1');
  });

  test('a session asks for its own viewport and headers before the first navigation', async () => {
    const { wire } = await opened(attach, {
      viewport: { width: 390, height: 844 },
      headers: { 'accept-language': 'es-co' },
    });
    const headers = wire.calls.find((call) => call.method === 'Network.setExtraHTTPHeaders');
    expect(headers?.params).toEqual({ headers: { 'accept-language': 'es-co' } });
    expect(headers?.sessionId).toBe('S1');
    expect(wire.calls.at(-1)?.method).toBe('Emulation.setDeviceMetricsOverride');
    expect(wire.calls.at(-1)?.params).toMatchObject({ width: 390, height: 844 });
  });

  test('close ends the launched browser once, however often it is called', async () => {
    const { session, closedCount } = await opened();
    await session.close();
    await session.close();
    expect(closedCount()).toBe(1);
  });

  test('an attached browser is closed too — it is somebody else’s bill', async () => {
    const wire = fakeWire(attach);
    const driver = cdpShotDriver({
      cdpUrl: 'http://sidecar:9222',
      fetchJson: async (url) => {
        expect(url).toBe('http://sidecar:9222/json/version');
        return { webSocketDebuggerUrl: 'ws://sidecar:9222/devtools/browser/abc' };
      },
      connect: async (endpoint) => {
        expect(endpoint).toBe('ws://sidecar:9222/devtools/browser/abc');
        return wire.connection;
      },
    });
    const session = await driver.open(init());
    await session.close();
    expect(wire.methods()).toContain('Browser.close');
  });

  test('no binary and no endpoint is X_CDP_BROWSER_MISSING, not a launch of nothing', async () => {
    const error = await cdpShotDriver({})
      .open(init())
      .catch((e: unknown) => e);
    expect(error).toBeUltimateError('X_CDP_BROWSER_MISSING');
  });
});

describe('unit · the allow list is enforced in the browser', () => {
  test('a goto to another host is refused before Page.navigate is sent', async () => {
    const { page, wire } = await opened();
    const error = await page.goto('http://169.254.169.254/latest').catch((e: unknown) => e);
    expect(error).toBeUltimateError('X_SHOT_HOST_REFUSED');
    expect(wire.methods()).not.toContain('Page.navigate');
  });

  test('a paused request off the list is failed and recorded as refused; one on it continues', async () => {
    const { page, wire } = await opened();
    wire.emit('Fetch.requestPaused', {
      requestId: 'F1',
      networkId: 'N1',
      resourceType: 'Image',
      request: { url: 'http://evil.test/x.png', method: 'GET' },
    });
    wire.emit('Fetch.requestPaused', {
      requestId: 'F2',
      networkId: 'N2',
      resourceType: 'Script',
      request: { url: 'http://localhost:3000/app.js', method: 'GET' },
    });
    await Bun.sleep(0);
    const failed = wire.calls.find((call) => call.method === 'Fetch.failRequest');
    const continued = wire.calls.find((call) => call.method === 'Fetch.continueRequest');
    expect(failed?.params).toEqual({ requestId: 'F1', errorReason: 'BlockedByClient' });
    expect(continued?.params).toEqual({ requestId: 'F2' });
    expect(page.network()).toEqual([
      expect.objectContaining({
        url: 'http://evil.test/x.png',
        resourceType: 'image',
        refused: 'host',
      }),
    ]);
  });
});

describe('unit · what the page saw is its own, and bounded', () => {
  test('console lines and exceptions on this session are kept; another session’s are not', async () => {
    const { page, wire } = await opened();
    wire.emit('Runtime.consoleAPICalled', {
      type: 'warning',
      args: [
        { type: 'string', value: 'slow' },
        { type: 'number', value: 3 },
      ],
    });
    wire.emit('Runtime.consoleAPICalled', { type: 'error', args: [{ value: 'theirs' }] }, 'S2');
    wire.emit('Runtime.exceptionThrown', {
      exceptionDetails: {
        text: 'Uncaught',
        exception: {
          className: 'TypeError',
          description: 'TypeError: x is null\n    at island.js:1:2',
        },
      },
    });
    expect(page.console().map((line) => [line.level, line.text])).toEqual([['warn', 'slow 3']]);
    expect(page.pageErrors()).toEqual([
      expect.objectContaining({
        message: 'x is null',
        stack: expect.stringContaining('island.js'),
      }),
    ]);
  });

  test('a response fills in its request’s status', async () => {
    const { page, wire } = await opened();
    wire.emit('Network.requestWillBeSent', {
      requestId: 'N1',
      type: 'Document',
      request: { url: 'http://localhost:3000/', method: 'GET' },
    });
    wire.emit('Network.responseReceived', { requestId: 'N1', response: { status: 200 } });
    expect(page.network()).toEqual([
      expect.objectContaining({
        url: 'http://localhost:3000/',
        status: 200,
        resourceType: 'document',
      }),
    ]);
    expect(page.networkDropped()).toBe(0);
  });
});

describe('unit · navigation', () => {
  test('goto waits for the load event and reads back where the page landed', async () => {
    const wire = fakeWire(
      evaluating((e) => (e === 'location.href' ? 'http://localhost:3000/in' : 'complete')),
    );
    const driver = cdpShotDriver({
      executablePath: '/c',
      launch: async () => ({ connection: wire.connection, close: () => undefined }),
    });
    const { page } = await driver.open(init());
    const going = page.goto('http://localhost:3000/');
    await Bun.sleep(0);
    wire.emit('Page.loadEventFired', {});
    await going;
    expect(page.url()).toBe('http://localhost:3000/in');
  });

  test('an errorText on the navigate reply is a refusal naming the url', async () => {
    const { page } = await opened((call) =>
      call.method === 'Page.navigate' ? { errorText: 'net::ERR_CONNECTION_REFUSED' } : attach(call),
    );
    const error = await page.goto('http://localhost:1/').catch((e: unknown) => e);
    expect(error).toBeUltimateError('X_CDP_CALL_FAILED');
    expect((error as { cause: string }).cause).toContain('ERR_CONNECTION_REFUSED');
  });
});

describe('unit · acting on an element', () => {
  test('click waits for a still element, then presses the mouse at its centre', async () => {
    const { page, wire } = await opened(evaluating(() => element()));
    await page.click('#go');
    const mouse = wire.calls.filter((call) => call.method === 'Input.dispatchMouseEvent');
    expect(mouse.map((call) => [call.params['type'], call.params['x'], call.params['y']])).toEqual([
      ['mouseMoved', 60, 40],
      ['mousePressed', 60, 40],
      ['mouseReleased', 60, 40],
    ]);
  });

  test('nothing matching is X_SHOT_ELEMENT_MISSING at the deadline', async () => {
    const { page } = await opened(evaluating(() => '[]'));
    const error = await page.waitFor('#nope', { timeout: 500 }).catch((e: unknown) => e);
    expect(error).toBeUltimateError('X_SHOT_ELEMENT_MISSING');
  });

  test('a covered element is X_SHOT_ELEMENT_UNREADY, naming what is wrong', async () => {
    const { page } = await opened(evaluating(() => element({ hitTarget: false })));
    const error = await page.click('#go', { timeout: 500 }).catch((e: unknown) => e);
    expect(error).toBeUltimateError('X_SHOT_ELEMENT_UNREADY');
    expect((error as { cause: string }).cause).toContain('covered');
  });

  test('a bad chord sends no key at all', async () => {
    const { page, wire } = await opened();
    const error = await page.press('Ctrl+K').catch((e: unknown) => e);
    expect(error).toBeUltimateError('X_SHOT_KEY_INVALID');
    expect(wire.methods()).not.toContain('Input.dispatchKeyEvent');
  });

  test('type focuses the field, then sends one key per character', async () => {
    const { page, wire } = await opened(
      evaluating((e) => (e.includes('focus()') ? undefined : element())),
    );
    await page.type('#go', 'hi');
    const keys = wire.calls.filter((call) => call.method === 'Input.dispatchKeyEvent');
    expect(keys.map((call) => [call.params['type'], call.params['text']])).toEqual([
      ['keyDown', 'h'],
      ['keyUp', undefined],
      ['keyDown', 'i'],
      ['keyUp', undefined],
    ]);
  });
});

describe('unit · capture and emulation', () => {
  test('a screenshot is the PNG bytes the browser sent', async () => {
    const { page } = await opened((call) =>
      call.method === 'Page.captureScreenshot' ? { data: btoa('\x89PNG') } : attach(call),
    );
    expect([...(await page.screenshot())]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  test('a full-page capture clips to the document, not the viewport', async () => {
    const { page, wire } = await opened((call) => {
      if (call.method === 'Page.getLayoutMetrics')
        return { cssContentSize: { width: 800, height: 2400.5 } };
      if (call.method === 'Page.captureScreenshot') return { data: btoa('x') };
      return attach(call);
    });
    await page.screenshot({ fullPage: true });
    const shot = wire.calls.find((call) => call.method === 'Page.captureScreenshot');
    expect(shot?.params).toMatchObject({
      clip: { x: 0, y: 0, width: 800, height: 2401, scale: 1 },
      captureBeyondViewport: true,
    });
  });

  test('fullPage beside a clip is refused rather than resolved in silence', async () => {
    const { page } = await opened();
    const error = await page
      .screenshot({ fullPage: true, clip: { x: 0, y: 0, width: 10, height: 10 } })
      .catch((e: unknown) => e);
    expect(error).toBeUltimateError('X_INVARIANT');
  });

  test("'no-preference' clears the emulated scheme instead of setting one", async () => {
    const { page, wire } = await opened();
    await page.colorScheme('dark');
    await page.colorScheme('no-preference');
    const media = wire.calls.filter((call) => call.method === 'Emulation.setEmulatedMedia');
    expect(media.map((call) => call.params['features'])).toEqual([
      [{ name: 'prefers-color-scheme', value: 'dark' }],
      [],
    ]);
  });

  test('accessibility answers the browser-computed role and name of each match', async () => {
    const { page } = await opened((call) => {
      if (call.method === 'DOM.getDocument') return { root: { nodeId: 1 } };
      if (call.method === 'DOM.querySelectorAll') return { nodeIds: [7] };
      if (call.method === 'DOM.describeNode') return { node: { backendNodeId: 70 } };
      if (call.method === 'Accessibility.getPartialAXTree') {
        return {
          nodes: [
            {
              ignored: false,
              role: { value: 'button' },
              name: { value: 'Save' },
              properties: [{ name: 'focused', value: { value: true } }],
            },
          ],
        };
      }
      return attach(call);
    });
    expect(await page.accessibility('button')).toEqual([
      { role: 'button', name: 'Save', focused: true, ignored: false },
    ]);
  });
});
