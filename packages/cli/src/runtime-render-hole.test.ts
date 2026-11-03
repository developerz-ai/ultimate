// A `<Hole>` through the real page handler: the first chunk leaves before the held read answers, the
// read runs in the request's context after the handler returned, and what a hole brings late — an
// island, its strategy, its realtime boot — arrives in its chunk under the policy the page serves.

import { afterEach, describe, expect, test } from 'bun:test';
import type { Actor } from '@ultimat3/core';
import {
  configureErrorReporting,
  memoryErrorReporter,
  resetErrorReporting,
  useContext,
  userActor,
} from '@ultimat3/core';
import {
  cspHashSource,
  defineHttpConfig,
  httpServer,
  setCookie,
  setRedirect,
} from '@ultimat3/http';
import {
  clearRoutes,
  defineRoute,
  Hole,
  h,
  island,
  registerRoute,
  routeFor,
} from '@ultimat3/render';
import type { IslandRealtime } from './island-realtime-state';
import { appRoutes, servedDocument } from './runtime-render';
import { inlineScriptSources } from './script-csp';

// A foreign failure handed to the subject: test input, never its verdict.
const READ_FAILED = new RangeError('the read failed');

const BUILD_ID = 'build-under-test';
const FILE = 'apps/web/app/feed/page.tsx';
const ALICE: Actor = userActor({ id: 'alice@example.com', permissions: [] });
const ASYNC_RUNTIME = '<script type="module" async>';
const DEFER_RUNTIME = '<script type="module">';
const BOOT = '/_x/page-boot/abcd1234.js';

const held = (): { promise: Promise<string>; open: (value: string) => void } => {
  let open: (value: string) => void = () => undefined;
  const promise = new Promise<string>((resolve) => {
    open = resolve;
  });
  return { promise, open };
};

const page = (body: () => unknown, hydrate: 'idle' | 'visible' = 'idle'): void => {
  registerRoute({
    file: FILE,
    config: defineRoute({
      render: 'stream',
      offline: 'network-only',
      hydrate,
      budget: { js: '100kb' },
      meta: () => ({ title: 'feed', description: 'a hole under test' }),
    }),
    component: body as never,
  });
};

type RouteOptions = Partial<Parameters<typeof appRoutes>[0]>;

const open = async (
  options: RouteOptions = {},
  headers: Record<string, string> = {},
): Promise<Response> => {
  const server = httpServer({
    routes: appRoutes({ buildId: BUILD_ID, ...options }),
    role: 'web',
    config: defineHttpConfig({ dev: true, buildId: BUILD_ID, rateLimit: { scope: 'process' } }),
    hooks: { authenticate: () => ALICE, authorize: () => ({ allowed: true }) },
  });
  return server.fetch(new Request('http://dev.test/feed', { headers }));
};

const realtime = (file: string): RouteOptions => ({
  sync: { syncUrl: '/_x/sync', buildId: BUILD_ID, bootUrl: BOOT },
  realtimeIslands: () => new Map<string, IslandRealtime>([[file, 'follows']]),
});

afterEach(() => {
  clearRoutes();
});

describe('unit · a hole through the page handler', () => {
  test('the first chunk holds the shell before the held read answers', async () => {
    const read = held();
    page(() =>
      h(
        'main',
        {},
        h('h1', {}, 'shell'),
        h(Hole, { fallback: 'wait' }, () => read.promise),
      ),
    );
    const response = await open();
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('no-store');
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toContain('<h1>shell</h1>');
    expect(first).toContain('<x-hole id="x:1">wait</x-hole>');
    expect(first).not.toContain('LATE-MARK');
    read.open('LATE-MARK');
    let rest = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      rest += new TextDecoder().decode(value);
    }
    expect(rest).toContain('data-x-hole="x:1">LATE-MARK</template>');
    expect(rest.endsWith('</body></html>')).toBe(true);
  });

  test('the request context is there after the handler returned', async () => {
    const gate = held();
    const Who = async (): Promise<string> => {
      await gate.promise;
      return `actor:${useContext().actor.id}`;
    };
    page(() => h(Hole, { fallback: 'wait' }, h(Who as never, {})));
    const response = await open();
    // The handler answered: this Response exists, and the read is still waiting on the gate.
    gate.open('go');
    expect(await response.text()).toContain('actor:alice@example.com');
  });

  test('a stream page with no hole registers and costs the document nothing', async () => {
    page(() => h('main', {}, 'static'));
    const html = await (await open()).text();
    expect(html).not.toContain('$X');
    expect(html).toContain('<main>static</main>');
  });
});

describe('unit · the hydration runtime, with holes open', () => {
  const Shell = island({ src: './shell.island.tsx' });
  const Late = island({ src: './late.island.tsx' });

  test('a shell island’s runtime is async: it must not wait for the slowest hole', async () => {
    const read = held();
    page(() =>
      h(
        'main',
        {},
        h(Shell, {}),
        h(Hole, { fallback: 'wait' }, () => read.promise),
      ),
    );
    const reader = ((await open()).body as ReadableStream<Uint8Array>).getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toContain(ASYNC_RUNTIME);
    expect(first).not.toContain(DEFER_RUNTIME);
    read.open('late');
    await reader.cancel();
  });

  test('with no hole the runtime is what it always was', async () => {
    page(() => h('main', {}, h(Shell, {})));
    const html = await (await open()).text();
    expect(html).toContain(DEFER_RUNTIME);
    expect(html).not.toContain(ASYNC_RUNTIME);
  });

  test('a realtime boot keeps the runtime deferred: the boot runs first', async () => {
    page(() => h('main', {}, h(Shell, {}), h(Hole, { fallback: 'wait' }, 'done')));
    const html = await (await open(realtime('apps/web/app/feed/shell.island.tsx'))).text();
    expect(html).toContain(`src="${BOOT}"`);
    expect(html).toContain(DEFER_RUNTIME);
    expect(html).not.toContain(ASYNC_RUNTIME);
  });

  test('a hole’s island brings its runtime in its chunk, after the reveal', async () => {
    const read = held();
    const Filled = async (): Promise<unknown> => {
      await read.promise;
      return h(Late, {}, 'late island');
    };
    page(() => h('main', {}, h(Hole, { fallback: 'wait' }, h(Filled as never, {}))));
    const reader = ((await open()).body as ReadableStream<Uint8Array>).getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    // Nothing on the shell needed one, and the document cannot know yet that a hole will.
    expect(first).not.toContain('type="module"');
    read.open('go');
    const chunk = new TextDecoder().decode((await reader.read()).value);
    const reveal = chunk.indexOf('<script>$X()</script>');
    expect(chunk).toContain('data-x-hole=');
    expect(reveal).toBeGreaterThan(chunk.indexOf('data-x-hole='));
    expect(chunk.indexOf(ASYNC_RUNTIME)).toBeGreaterThan(reveal);
  });

  test('an island recorded by a hole still open is not spent on the chunk that answered first', async () => {
    const slow = held();
    const Second = island({ src: './second.island.tsx' });
    page(() =>
      h(
        'main',
        {},
        // Records its island at once, then waits: its root reaches the DOM only with its own chunk.
        h(Hole, { fallback: 'a' }, h(Second, {}, 'second'), () => slow.promise),
        h(Hole, { fallback: 'b' }, h(Late, {}, 'first')),
      ),
    );
    const reader = ((await open()).body as ReadableStream<Uint8Array>).getReader();
    await reader.read();
    const answered = new TextDecoder().decode((await reader.read()).value);
    expect(answered).toContain('>first<');
    expect(answered).not.toContain('>second<');
    slow.open('go');
    const last = new TextDecoder().decode((await reader.read()).value);
    expect(last).toContain('>second<');
    expect(last).toContain(ASYNC_RUNTIME);
  });

  test('a hole’s realtime island brings the boot once, and the runtime after it stays deferred', async () => {
    const Live = island({ src: './live.island.tsx' });
    page(() =>
      h(
        'main',
        {},
        h(Hole, { fallback: 'a' }, h(Live, {}, 'one')),
        h(Hole, { fallback: 'b' }, h(Live, {}, 'two')),
      ),
    );
    const html = await (await open(realtime('apps/web/app/feed/live.island.tsx'))).text();
    expect(html.split(`src="${BOOT}"`)).toHaveLength(2);
    expect(html).toContain(DEFER_RUNTIME);
    expect(html).not.toContain(ASYNC_RUNTIME);
    expect(html).toContain(`src="${BOOT}"`);
    expect(html.indexOf(`src="${BOOT}"`)).toBeLessThan(html.indexOf(DEFER_RUNTIME));
  });

  test('every inline script a streamed document carries is one the policy hashes', async () => {
    page(() =>
      h('main', {}, h(Shell, {}), h(Hole, { fallback: 'wait' }, h(Late, {}, 'late island'))),
    );
    const html = await (await open()).text();
    const sources = inlineScriptSources();
    const bodies = [...html.matchAll(/<script(?<attrs>[^>]*)>(?<body>[\s\S]*?)<\/script>/g)]
      .filter((match) => !match.groups?.['attrs']?.includes('application/json'))
      .map((match) => match.groups?.['body'] ?? '');
    expect(bodies.length).toBe(4);
    for (const body of bodies) expect(sources).toContain(cspHashSource(body));
  });
});

describe('unit · what runs inside a hole', () => {
  const reports = memoryErrorReporter();
  afterEach(() => {
    reports.reset();
    resetErrorReporting();
  });

  const drained = async (response: Response): Promise<string> => response.text();

  test('a failed hole’s error markup brings the runtime its island needs', async () => {
    const Retry = island({ src: './retry.island.tsx' });
    const Fails = async (): Promise<unknown> => {
      await Promise.resolve();
      throw READ_FAILED;
    };
    page(() =>
      h(
        'main',
        {},
        h(Hole, { fallback: 'wait', error: h(Retry, {}, 'retry') }, h(Fails as never, {})),
      ),
    );
    const html = await drained(await open());
    const reveal = html.indexOf('<script>$X()</script>');
    expect(html).toContain('<script>$X()</script>');
    expect(html.indexOf('data-x-island', html.indexOf('<template'))).toBeGreaterThan(0);
    expect(html.indexOf(ASYNC_RUNTIME, reveal)).toBeGreaterThan(reveal);
  });

  test.each([
    ['setCookie', () => setCookie('late', '1')],
    ['setRedirect', () => setRedirect('/elsewhere')],
  ])(
    '%s after the flush is refused, not dropped: the hole fails and a monitor hears',
    async (_name, write) => {
      configureErrorReporting({ reporter: reports });
      const Writes = async (): Promise<string> => {
        await Promise.resolve();
        write();
        return 'wrote';
      };
      page(() => h(Hole, { fallback: 'wait', error: 'refused' }, h(Writes as never, {})));
      const response = await open();
      const html = await drained(response);
      expect(response.status).toBe(200);
      expect(response.headers.get('set-cookie')).toBeNull();
      expect(response.headers.get('location')).toBeNull();
      expect(html).toContain('>refused</template>');
      expect(reports.events.map((report) => report.code)).toEqual(['X_STREAM_ALREADY_FLUSHED']);
      expect(reports.events[0]?.fix).toContain('load');
    },
  );

  test('the ambient signal inside a hole is the hole’s: a client that left stops the read', async () => {
    let stopped = false;
    const Waits = (): Promise<string> =>
      new Promise((resolve) => {
        useContext().signal.addEventListener('abort', () => {
          stopped = true;
          resolve('stopped');
        });
      });
    page(() => h(Hole, { fallback: 'wait' }, h(Waits as never, {})));
    const reader = ((await open()).body as ReadableStream<Uint8Array>).getReader();
    await reader.read();
    await reader.cancel();
    expect(stopped).toBe(true);
  });

  test('a request header can still be read inside a hole', async () => {
    const { useRequestHeader } = await import('@ultimat3/http');
    const Reads = async (): Promise<string> => {
      await Promise.resolve();
      return `probe:${useRequestHeader('x-probe') ?? 'none'}`;
    };
    page(() => h(Hole, { fallback: 'wait' }, h(Reads as never, {})));
    expect(await drained(await open({}, { 'x-probe': 'kept' }))).toContain('probe:kept');
  });
});

describe('unit · what the budget weighs', () => {
  test('a stream page’s measured document holds the hole’s island, inline, with its runtime', async () => {
    const Late = island({ src: './late.island.tsx' });
    page(() => h('main', {}, h(Hole, { fallback: 'wait' }, h(Late, {}, 'late island'))));
    const entry = routeFor('/feed');
    if (entry === undefined) expect.unreachable('the page did not register');
    const html = await servedDocument(entry, { url: 'http://dev.test/feed', params: {} }, ALICE, {
      buildId: BUILD_ID,
    });
    expect(html).toContain('late island');
    expect(html).toContain('data-x-island');
    expect(html).toContain(DEFER_RUNTIME);
    expect(html).not.toContain('<x-hole');
  });
});
