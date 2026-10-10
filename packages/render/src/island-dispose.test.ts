// Letting go of mounted islands, over the fake DOM: what `mount` returned is called once its boot
// resolves, a boot that never started is settled so it mounts nothing, and the root counts when it
// is an island's wrapper itself — the shape an island dropping its own server markup hands over.
import { describe, expect, test } from 'bun:test';
import { disposeIslands } from './island-dispose';
import { type FakeElement, h } from './navigation-dom-fixture';

const el = (node: FakeElement) => node as unknown as Element;

describe('islands', () => {
  test('disposed through what mount returned — unless kept, unbooted, or failed', async () => {
    const disposed: string[] = [];
    const island = (name: string, boot?: Promise<unknown>) => {
      const node = h('div', { 'data-x-island': name });
      if (boot !== undefined) node.__x = boot;
      return node;
    };
    const kept = island(
      'kept',
      Promise.resolve(() => disposed.push('kept')),
    );
    const root = h('div', {}, [
      island(
        'a',
        Promise.resolve(() => disposed.push('a')),
      ),
      island('not-a-function', Promise.resolve('value')),
      island('failed', Promise.reject(new TypeError('mount threw'))),
      island('never-booted'),
      kept,
    ]);
    const count = disposeIslands(el(root), (node) => node === el(kept));
    await Promise.resolve();
    await Promise.resolve();
    expect(count).toBe(3);
    expect(disposed).toEqual(['a']);
  });

  test('an island whose boot never started is settled, so its pending boot mounts nothing', async () => {
    const pending = h('div', { 'data-x-island': 'idle-pending' });
    const kept = h('div', { 'data-x-island': 'kept-pending' });
    disposeIslands(el(h('div', {}, [pending, kept])), (node) => node === el(kept));
    // What the runtime's `boot` reads: an `__x` already there is returned, never re-imported.
    expect(pending.__x).toBeInstanceOf(Promise);
    expect(await pending.__x).toBeUndefined();
    // A carried island is the tab's: its own boot still runs.
    expect(kept.__x).toBeUndefined();
  });

  test('with no `kept`, every island under the root goes — the root too when it is one', async () => {
    const disposed: string[] = [];
    const menu = h('div', { 'data-x-island': 'menu' });
    menu.__x = Promise.resolve(() => disposed.push('menu'));
    const row = h('div', { 'data-x-island': 'row' }, [menu]);
    row.__x = Promise.resolve(() => disposed.push('row'));
    // Detached: the caller already took the row off the page, and the protocol does not care.
    expect(disposeIslands(el(row))).toBe(2);
    await Promise.resolve();
    await Promise.resolve();
    expect(disposed).toEqual(['row', 'menu']);
  });

  test('a root that is an unbooted island is settled like any other', async () => {
    const pending = h('div', { 'data-x-island': 'pending-root' });
    expect(disposeIslands(el(pending))).toBe(0);
    expect(await pending.__x).toBeUndefined();
  });

  test('the browser entry exports it, as the one function the router uses', async () => {
    const client = await import('@ultimat3/render/client');
    expect(client.disposeIslands).toBe(disposeIslands);
  });
});
