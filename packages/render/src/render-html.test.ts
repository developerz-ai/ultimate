import { describe, expect, test } from 'bun:test';
import { Fragment, h } from './jsx';
import { renderComponent, renderToHtml } from './render-html';

describe('renderToHtml', () => {
  test('renders an element with its attributes and children', async () => {
    expect(await renderToHtml(h('main', { class: 'hero' }, h('h1', null, 'Title')))).toBe(
      '<main class="hero"><h1>Title</h1></main>',
    );
  });

  test('a void element has no closing tag and ignores children', async () => {
    expect(await renderToHtml(h('img', { src: '/a.png' }, 'ignored'))).toBe('<img src="/a.png">');
  });

  test('text children are escaped', async () => {
    expect(await renderToHtml(h('p', null, '<script>'))).toBe('<p>&lt;script&gt;</p>');
  });

  test('nothing renders for the empty values JSX uses as guards', async () => {
    expect(await renderToHtml([null, undefined, false, true])).toBe('');
  });

  test('a fragment adds no wrapper element', async () => {
    expect(await renderToHtml(h(Fragment, null, h('i', null, 'a'), h('b', null, 'c')))).toBe(
      '<i>a</i><b>c</b>',
    );
  });

  test('a component is called with its props', async () => {
    const Greeting = (props: Record<string, unknown>): unknown =>
      h('p', null, `hi ${String(props['name'])}`);
    expect(await renderToHtml(h(Greeting, { name: 'ada' }))).toBe('<p>hi ada</p>');
  });

  test('an async component is awaited, which is what `ssr` needs', async () => {
    const Slow = async (): Promise<unknown> => {
      await Promise.resolve();
      return h('p', null, 'late');
    };
    expect(await renderToHtml(h(Slow, null))).toBe('<p>late</p>');
  });

  test('a thunk child is called, so a signal read renders its value', async () => {
    expect(await renderToHtml(h('p', null, () => 'read'))).toBe('<p>read</p>');
  });

  test('an array child renders in order', async () => {
    expect(await renderToHtml(h('ul', null, [h('li', null, 1), h('li', null, 2)]))).toBe(
      '<ul><li>1</li><li>2</li></ul>',
    );
  });

  test('innerHTML is the one prop that emits unescaped markup', async () => {
    expect(await renderToHtml(h('div', { innerHTML: '<b>raw</b>' }))).toBe('<div><b>raw</b></div>');
  });

  test('a component that renders itself fails with a cause, not a stack overflow', async () => {
    const Loop = (): unknown => h(Loop, null);
    expect(renderToHtml(h(Loop, null))).rejects.toThrow(/renders itself/);
  });

  // The bound was on `renderNode` alone, so it only held for the ELEMENT path. `unwrap` recurses
  // through arrays and thunks with no check of its own, and both are reachable from a component's
  // children — so a cycle there escaped `renderToHtml` (on the `./server` barrel, and what
  // `dev-render.ts` calls for a raw tree) as a bare `RangeError` with no code and no fix.
  describe('the depth bound holds on every recursion, not only on elements', () => {
    const coded = async (work: Promise<unknown>): Promise<{ code?: unknown; fix?: unknown }> => {
      try {
        await work;
      } catch (error) {
        return error as { code?: unknown; fix?: unknown };
      }
      return expect.unreachable('the cyclic tree rendered');
    };

    test('an array that contains itself is X_PRERENDER_FAILED, not a RangeError', async () => {
      const cycle: unknown[] = [];
      cycle.push(cycle);
      const failure = await coded(renderToHtml(h(() => h('div', null, cycle), null)));
      expect(failure.code).toBe('X_PRERENDER_FAILED');
      expect(typeof failure.fix).toBe('string');
    });

    test('a thunk that returns itself is X_PRERENDER_FAILED too', async () => {
      const self = (): unknown => self;
      const failure = await coded(renderToHtml(h('div', null, self)));
      expect(failure.code).toBe('X_PRERENDER_FAILED');
    });

    test('a cycle handed straight to renderToHtml is caught at the top of the walk', async () => {
      const cycle: unknown[] = [];
      cycle.push(cycle);
      expect((await coded(renderToHtml(cycle))).code).toBe('X_PRERENDER_FAILED');
    });

    test('a deep but finite tree still renders', async () => {
      let node: unknown = 'leaf';
      for (let i = 0; i < 50; i += 1) node = h('div', null, [node]);
      expect(await renderToHtml(node)).toContain('leaf');
    });
  });
});

describe('renderComponent', () => {
  test('names the file when the component throws', async () => {
    const Broken = (): unknown => {
      throw new TypeError('boom');
    };
    expect(renderComponent(Broken, {}, 'apps/web/site/page.tsx')).rejects.toThrow(
      /apps\/web\/site\/page\.tsx threw: TypeError: boom/,
    );
  });

  test('passes the props straight through', async () => {
    const Echo = (props: Record<string, unknown>): unknown => h('p', null, String(props['url']));
    expect(await renderComponent(Echo, { url: '/x' }, 'apps/web/site/page.tsx')).toBe('<p>/x</p>');
  });
});

/**
 * A component is app code and may throw a value that fights being read. Every one of these has to
 * come back as `X_PRERENDER_FAILED` naming the file — `error instanceof Error ? error.message :
 * String(error)` answered a bare `TypeError` for the first and a bare `Error` for the second, so
 * the one frame that owes the build a coded failure produced none.
 */
describe('renderComponent when the thrown value fights being read', () => {
  const codeOf = (error: unknown): unknown =>
    typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;

  async function thrownBy(value: unknown): Promise<unknown> {
    const Broken = (): unknown => {
      throw value;
    };
    try {
      await renderComponent(Broken, {}, 'apps/web/site/page.tsx');
    } catch (error) {
      return error;
    }
    return undefined;
  }

  test('a null-prototype object is X_PRERENDER_FAILED, not a TypeError from String()', async () => {
    const error = await thrownBy(Object.create(null));
    expect(codeOf(error)).toBe('X_PRERENDER_FAILED');
    expect(String((error as { cause: string }).cause)).toContain('apps/web/site/page.tsx');
  });

  test('an Error whose message getter throws is X_PRERENDER_FAILED too', async () => {
    const hostile = new Error('never read');
    Object.defineProperty(hostile, 'message', {
      get() {
        throw new TypeError('message is a trap');
      },
    });
    const error = await thrownBy(hostile);
    expect(codeOf(error)).toBe('X_PRERENDER_FAILED');
  });

  test('a thrown string still reaches the cause', async () => {
    const error = await thrownBy('plain failure');
    expect(codeOf(error)).toBe('X_PRERENDER_FAILED');
    expect(String((error as { cause: string }).cause)).toContain('plain failure');
  });
});
