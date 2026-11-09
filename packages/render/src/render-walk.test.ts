// The walker's synchronous fast path keeps the async walker's contract: output in tree order
// whatever settles first, side effects (component calls, hole ids) in tree order with every
// sibling's synchronous prefix before any await, and no rejection left unobserved by a sync throw.

import { describe, expect, test } from 'bun:test';
import { Hole } from './hole';
import { h } from './jsx';
import { holeSink, renderToHtml } from './render-html';
import { renderAlone } from './render-walk';

/** A promise the test settles by hand, so "settles first" is an order the test chooses. */
function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (reason: unknown) => void = () => undefined;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

/** One event-loop turn: every microtask queued so far has run. */
const turn = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

// A foreign failure handed to the subject: test input, never its verdict.
const NOW = new TypeError('now');

describe('the synchronous fast path', () => {
  test('a tree with nothing to await renders to a string, not a promise', () => {
    expect(
      renderAlone(
        h(
          'p',
          null,
          'a',
          1,
          h('b', null, () => 'c'),
        ),
        0,
        {},
      ),
    ).toBe('<p>a1<b>c</b></p>');
  });

  test('one awaited leaf makes the render a promise, in tree order', async () => {
    const b = deferred<string>();
    const d = deferred<string>();
    const out = renderAlone(['a', b.promise, 'c', d.promise, 'e'], 0, {});
    expect(out).toBeInstanceOf(Promise);
    d.resolve('d');
    await turn();
    b.resolve('b');
    expect(await out).toBe('abcde');
  });

  test('a promise resolving to a tree is walked, escaped like any other text', async () => {
    expect(await renderToHtml(h('div', null, Promise.resolve(h('i', null, '<x>'))))).toBe(
      '<div><i>&lt;x&gt;</i></div>',
    );
  });
});

describe('side effects run in tree order', () => {
  test('every sibling component is called before any awaited one settles', async () => {
    const calls: string[] = [];
    const gate = deferred<null>();
    const Slow = async (): Promise<unknown> => {
      calls.push('slow');
      await gate.promise;
      calls.push('slow settled');
      return h('span', null, 'slow');
    };
    const Fast = (props: { readonly name?: unknown }): unknown => {
      calls.push(String(props.name));
      return String(props.name);
    };
    const rendering = renderToHtml([
      h(Fast, { name: 'one' }),
      h(Slow, null),
      h(Fast, { name: 'two' }),
    ]);
    await turn();
    expect(calls).toEqual(['one', 'slow', 'two']);
    gate.resolve(null);
    expect(await rendering).toBe('one<span>slow</span>two');
    expect(calls).toEqual(['one', 'slow', 'two', 'slow settled']);
  });

  test("hole ids follow the tree even when a later hole's fallback settles first", async () => {
    const sink = holeSink();
    const a = deferred<string>();
    const rendering = renderToHtml(
      [Hole({ fallback: a.promise, children: 'a' }), Hole({ fallback: 'B', children: 'b' })],
      { holes: sink },
    );
    await turn();
    a.resolve('A');
    const html = await rendering;
    expect(sink.holes.map((hole) => [hole.id, hole.fallback])).toEqual(
      expect.arrayContaining([
        ['1', 'A'],
        ['2', 'B'],
      ]),
    );
    expect(html).toContain('A');
    expect(html).toContain('B');
    expect(html.indexOf('A')).toBeLessThan(html.indexOf('B'));
  });
});

describe('a synchronous throw beside a pending sibling', () => {
  test('rejects with the throw and leaves no unhandled rejection behind', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const failing = deferred<string>();
      const Throws = (): unknown => {
        throw NOW;
      };
      await expect(renderToHtml([failing.promise, h(Throws, null)])).rejects.toBe(NOW);
      failing.reject('late');
      await turn();
      await turn();
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
