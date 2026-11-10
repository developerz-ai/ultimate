// `<Hole>` over the real walker and the real stream: the marker survives a wrapping component and
// the island/array order, a hole's children start with the stream and fill out of order, and every
// render that has no sink — ssr, static, a test, the budget's — awaits the same tree inline.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { MemoryErrorReporter } from '@ultimat3/core';
import { memoryErrorReporter, resetErrorReporting } from '@ultimat3/core';
import { installErrorReporter } from '@ultimat3/core/adapter';
import { HOLE_NODE } from '@ultimat3/core/render-node';
import { Hole, isHoleNode } from './hole';
import { drainDeclaredIslands, island } from './island';
import { islandCollector } from './island-collector';
import { h } from './jsx';
import type { HoleSink } from './render-html';
import { holeSink, renderToHtml } from './render-html';
import { collectStream, holeMarker, renderStreamHtml } from './render-stream';

// `island()` records a declaration for the NEXT `defineRoute` in the process: drained here, or the
// next test file's module-level route inherits this file's badge islands.
afterEach(() => {
  drainDeclaredIslands();
});

// A foreign failure handed to the subject: test input, never its verdict.
const BOOM = new RangeError('boom');

const held = (): { promise: Promise<string>; open: (value: string) => void } => {
  let open: (value: string) => void = () => undefined;
  const promise = new Promise<string>((resolve) => {
    open = resolve;
  });
  return { promise, open };
};

/** A shell, walked the way the `stream` branch walks it. */
const shellOf = async (tree: unknown): Promise<{ shell: string; sink: HoleSink }> => {
  const sink = holeSink();
  return { shell: await renderToHtml(tree, { holes: sink }), sink };
};

const stream = (shell: string, sink: HoleSink): ReadableStream<Uint8Array> =>
  renderStreamHtml(
    { head: '<head>', shell, holes: sink.holes },
    { buildId: 'b', holeTimeoutMs: null },
  );

const decoded = async (reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> => {
  const { value } = await reader.read();
  return new TextDecoder().decode(value);
};

describe('the marker', () => {
  test('is an array to the type system, and tested before the array branch', () => {
    const node = Hole({ fallback: 'wait', children: 'done' });
    expect(isHoleNode(node)).toBe(true);
    expect(Array.isArray(node)).toBe(true);
    expect(isHoleNode([])).toBe(false);
  });

  test("its brand is core's HOLE_NODE, the one a tier-0 walker reads", () => {
    expect(isHoleNode(Hole({ fallback: 'wait', children: 'done' }))).toBe(true);
    expect(HOLE_NODE in (Hole({ fallback: 'wait', children: 'done' }) as object)).toBe(true);
  });

  test('hole.ts imports only the brand leaf, so a client graph pays a symbol and a function', async () => {
    const source = await Bun.file(`${import.meta.dir}/hole.ts`).text();
    const imports = source.match(/^\s*(import|export .* from)\b.*$/gm) ?? [];
    expect(imports.map((line) => line.trim())).toEqual([
      "import { HOLE_NODE } from '@ultimat3/core/render-node';",
    ]);
  });

  test('reaches the walker through a wrapping component', async () => {
    const Wrapped = (props: { readonly children?: unknown }) =>
      h(Hole, { fallback: h('i', {}, 'wait') }, props.children);
    const { shell, sink } = await shellOf(h('main', {}, h(Wrapped, {}, 'done')));
    expect(shell).toBe(`<main>${holeMarker('1', '<i>wait</i>')}</main>`);
    expect(sink.holes.map((hole) => hole.fallback)).toEqual(['<i>wait</i>']);
    expect(await sink.holes[0]?.resolve(new AbortController().signal)).toBe('done');
  });

  test('its id goes through the one escaper', () => {
    expect(holeMarker('a"b', '')).toContain('id="x:a&quot;b"');
  });
});

describe('with a sink', () => {
  test('nothing under a hole runs before the stream starts', async () => {
    let ran = 0;
    const Slow = () => {
      ran += 1;
      return 'slow';
    };
    const { shell, sink } = await shellOf(h(Hole, { fallback: 'wait' }, h(Slow, {})));
    expect(ran).toBe(0);
    await collectStream(stream(shell, sink));
    expect(ran).toBe(1);
  });

  test('the shell flushes first, then holes fill in completion order, then the document closes', async () => {
    const fast = held();
    const slow = held();
    const { shell, sink } = await shellOf(
      h(
        'main',
        {},
        h(Hole, { fallback: 'a' }, () => slow.promise),
        h(Hole, { fallback: 'b' }, () => fast.promise),
      ),
    );
    const reader = stream(shell, sink).getReader();
    const first = await decoded(reader);
    expect(first).toContain(holeMarker('1', 'a'));
    expect(first).toContain(holeMarker('2', 'b'));
    expect(first).not.toContain('<template');

    fast.open('FAST');
    expect(await decoded(reader)).toContain('data-x-hole="x:2">FAST');
    slow.open('SLOW');
    expect(await decoded(reader)).toContain('data-x-hole="x:1">SLOW');
    expect(await decoded(reader)).toBe('</body></html>');
    expect((await reader.read()).done).toBe(true);
  });

  test('a nested hole renders inline inside the outer one', async () => {
    const { shell, sink } = await shellOf(
      h(Hole, { fallback: 'outer' }, h('p', {}, h(Hole, { fallback: 'inner' }, 'deep'))),
    );
    expect(sink.holes).toHaveLength(1);
    const html = await collectStream(stream(shell, sink));
    expect(html).toContain('<p>deep</p>');
    expect(html).not.toContain('inner');
  });

  test('a hole in a fallback renders inline: a fallback has no later flush', async () => {
    const { shell, sink } = await shellOf(
      h(Hole, { fallback: h(Hole, { fallback: 'never shown' }, 'inline') }, 'done'),
    );
    expect(sink.holes).toHaveLength(1);
    expect(shell).toContain('>inline</x-hole>');
  });

  test('an island inside a hole is collected when the hole resolves, not at the shell', async () => {
    const Badge = island({ src: './badge.island.tsx' });
    const islands = islandCollector({ file: 'page.tsx', hydrate: 'idle' });
    const sink = holeSink();
    const shell = await renderToHtml(h(Hole, { fallback: 'wait' }, h(Badge, {}, 'badge')), {
      islands,
      holes: sink,
    });
    expect(shell).not.toContain('data-x-island');
    expect(islands.directives).toHaveLength(0);
    const html = await sink.holes[0]?.resolve(new AbortController().signal);
    expect(html).toContain('data-x-island');
    expect(islands.directives).toHaveLength(1);
  });
});

describe('without a sink: ssr, static, a test, the budget', () => {
  test('awaits its children inline and shows no fallback', async () => {
    const html = await renderToHtml(
      h(
        'main',
        {},
        h(Hole, { fallback: 'wait' }, () => Promise.resolve('done')),
      ),
    );
    expect(html).toBe('<main>done</main>');
  });

  test('weighs a hole’s island: the collector sees it', async () => {
    const Badge = island({ src: './badge.island.tsx' });
    const islands = islandCollector({ file: 'page.tsx', hydrate: 'idle' });
    const html = await renderToHtml(h(Hole, { fallback: 'wait' }, h(Badge, {})), { islands });
    expect(html).toContain('data-x-island');
    expect(islands.directives).toHaveLength(1);
  });

  test('a throw under a hole is the render’s throw: there is no fallback to show', async () => {
    const Boom = (): unknown => {
      throw BOOM;
    };
    await expect(renderToHtml(h(Hole, { fallback: 'wait' }, h(Boom, {})))).rejects.toThrow('boom');
  });
});

describe('when a hole fails', () => {
  let reports: MemoryErrorReporter;
  beforeEach(() => {
    reports = memoryErrorReporter();
    installErrorReporter(reports);
  });
  afterEach(() => {
    resetErrorReporting();
  });

  const Boom = (): unknown => {
    throw BOOM;
  };

  test('its own error markup replaces the fallback, the document closes, a monitor hears', async () => {
    const { shell, sink } = await shellOf(
      h(Hole, { fallback: 'wait', error: h('b', {}, 'sorry') }, h(Boom, {})),
    );
    const html = await collectStream(stream(shell, sink));
    expect(html).toContain('data-x-hole="x:1"><b>sorry</b>');
    expect(html.endsWith('</body></html>')).toBe(true);
    expect(reports.events.map((report) => report.source)).toEqual(['http']);
    expect(reports.events[0]?.cause).toContain('boom');
  });

  test('with no error markup it is the hidden default, and is still reported', async () => {
    const { shell, sink } = await shellOf(h(Hole, { fallback: 'wait' }, h(Boom, {})));
    const html = await collectStream(stream(shell, sink));
    expect(html).toContain('data-x-hole-error="1"');
    expect(reports.events).toHaveLength(1);
  });

  test('a deadline uses the error markup and reports X_TIMEOUT', async () => {
    const never = new Promise<string>(() => undefined);
    const { shell, sink } = await shellOf(
      h(Hole, { fallback: 'wait', error: 'too slow' }, () => never),
    );
    const html = await collectStream(
      renderStreamHtml({ head: '', shell, holes: sink.holes }, { buildId: 'b', holeTimeoutMs: 1 }),
    );
    expect(html).toContain('>too slow</template>');
    expect(reports.events.map((report) => report.code)).toEqual(['X_TIMEOUT']);
  });

  test('a client that left is nobody’s failure: no report, for a rejection or a deadline', async () => {
    let reject: (reason: unknown) => void = () => undefined;
    const rejecting = new Promise<string>((_resolve, rejected) => {
      reject = rejected;
    });
    const never = new Promise<string>(() => undefined);
    const reader = renderStreamHtml(
      {
        head: '',
        shell: '',
        holes: [
          { id: 'a', fallback: '', resolve: () => rejecting },
          { id: 'b', fallback: '', resolve: () => never },
        ],
      },
      { buildId: 'b', holeTimeoutMs: 1 },
    ).getReader();
    await reader.read();
    await reader.cancel();
    reject(BOOM);
    // A second stream's deadline, armed later with the same delay, fires after the cancelled one's.
    await collectStream(
      renderStreamHtml(
        { head: '', shell: '', holes: [{ id: 'c', fallback: '', resolve: () => never }] },
        { buildId: 'b', holeTimeoutMs: 1 },
      ),
    );
    expect(reports.events.map((report) => report.cause)).toEqual([
      expect.stringContaining('stream hole c'),
    ]);
  });
});

describe('what a hole owns', () => {
  const failing = (after: () => string): ReadableStream<Uint8Array> =>
    renderStreamHtml(
      {
        head: '',
        shell: '',
        holes: [
          { id: 'a', fallback: '', error: 'retry', after, resolve: () => Promise.reject(BOOM) },
        ],
      },
      { buildId: 'b', holeTimeoutMs: null },
    );

  test('a failed hole’s chunk carries `after` too: its error markup may hold an island', async () => {
    const html = await collectStream(failing(() => '<script type="module">rt()</script>'));
    expect(html).toContain(
      '>retry</template><script>$X()</script><script type="module">rt()</script>',
    );
  });

  test('a timed-out hole’s chunk carries `after` too', async () => {
    const html = await collectStream(
      renderStreamHtml(
        {
          head: '',
          shell: '',
          holes: [
            {
              id: 'a',
              fallback: '',
              after: () => '<i>after</i>',
              resolve: () => new Promise<string>(() => undefined),
            },
          ],
        },
        { buildId: 'b', holeTimeoutMs: 1 },
      ),
    );
    expect(html).toContain('<script>$X()</script><i>after</i>');
  });

  test('a promise written straight in as a child is never an unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const listen = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', listen);
    try {
      const { sink } = await shellOf(h(Hole, { fallback: 'wait' }, Promise.reject(BOOM)));
      // Two macrotasks: the runtime reports an unhandled rejection after the microtask queue drains.
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
      await expect(sink.holes[0]?.resolve(new AbortController().signal)).rejects.toBe(BOOM);
    } finally {
      process.off('unhandledRejection', listen);
    }
  });

  test('a promise deep in a hole’s JSX is observed too, while an async fallback renders', async () => {
    const unhandled: unknown[] = [];
    const listen = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', listen);
    try {
      const deep = Promise.reject(BOOM);
      const SlowFallback = async (): Promise<string> => {
        await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setImmediate(resolve));
        return 'wait';
      };
      const { sink } = await shellOf(
        h(Hole, { fallback: h(SlowFallback as never, {}) }, h('div', {}, [h('p', {}, deep)])),
      );
      expect(unhandled).toEqual([]);
      await expect(sink.holes[0]?.resolve(new AbortController().signal)).rejects.toBe(BOOM);
    } finally {
      process.off('unhandledRejection', listen);
    }
  });

  test('a hole that resolves after its deadline asks `after` once', async () => {
    let asked = 0;
    let finish: (value: string) => void = () => undefined;
    const late = new Promise<string>((resolve) => {
      finish = resolve;
    });
    await collectStream(
      renderStreamHtml(
        {
          head: '',
          shell: '',
          holes: [
            {
              id: 'a',
              fallback: '',
              after: () => {
                asked += 1;
                return '';
              },
              resolve: () => late,
            },
          ],
        },
        { buildId: 'b', holeTimeoutMs: 1 },
      ),
    );
    finish('late');
    await late;
    await new Promise((resolve) => setImmediate(resolve));
    expect(asked).toBe(1);
  });

  test('the deadline aborts the hole’s own signal with X_TIMEOUT', async () => {
    let seen: AbortSignal | undefined;
    await collectStream(
      renderStreamHtml(
        {
          head: '',
          shell: '',
          holes: [
            {
              id: 'a',
              fallback: '',
              resolve: (signal) => {
                seen = signal;
                return new Promise<string>(() => undefined);
              },
            },
          ],
        },
        { buildId: 'b', holeTimeoutMs: 1 },
      ),
    );
    expect(seen?.aborted).toBe(true);
    expect((seen?.reason as { code?: string } | undefined)?.code).toBe('X_TIMEOUT');
  });

  test('a hole still running when the document closes was stopped by its deadline', async () => {
    const signals: AbortSignal[] = [];
    await collectStream(
      renderStreamHtml(
        {
          head: '',
          shell: '',
          holes: [
            {
              id: 'a',
              fallback: '',
              resolve: (signal) => {
                signals.push(signal);
                return new Promise<string>(() => undefined);
              },
            },
            { id: 'b', fallback: '', resolve: async () => 'b' },
          ],
        },
        { buildId: 'b', holeTimeoutMs: 1 },
      ),
    );
    expect(signals[0]?.aborted).toBe(true);
  });

  test('the walk hands the hole’s signal to `enter`, which runs the children', async () => {
    const signals: AbortSignal[] = [];
    const sink = holeSink({
      enter: (signal, run) => {
        signals.push(signal);
        return run();
      },
    });
    await renderToHtml(h(Hole, { fallback: 'wait' }, 'done'), { holes: sink });
    const controller = new AbortController();
    expect(await sink.holes[0]?.resolve(controller.signal)).toBe('done');
    expect(signals).toEqual([controller.signal]);
  });

  test('a document with a hole open writes a comment while it waits, so no idle socket is cut', async () => {
    const read = held();
    const reader = renderStreamHtml(
      { head: '', shell: 'shell', holes: [{ id: 'a', fallback: '', resolve: () => read.promise }] },
      { buildId: 'b', holeTimeoutMs: null, keepAliveMs: 1 },
    ).getReader();
    await reader.read();
    expect(await decoded(reader)).toBe('<!---->');
    read.open('done');
    let rest = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      rest += new TextDecoder().decode(value);
    }
    expect(rest).toContain('data-x-hole="x:a">done');
  });
});
