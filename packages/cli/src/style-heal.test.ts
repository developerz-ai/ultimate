// The stylesheet self-heal, run as the browser runs it: its own string, against a window the test
// drives — a failed sheet reloads once, never twice for one URL, never for a script or a sheet
// that fails after `load`, and a clean load clears the marker so the next skew heals again.
import { describe, expect, test } from 'bun:test';
import { STYLE_HEAL_BODY, STYLE_HEAL_KEY, STYLE_HEAL_TAG } from './style-heal';

type Listener = (event: unknown) => void;

/** One page load: the window the script sees, sharing `storage` across loads like a tab does. */
function load(storage: Map<string, string> | null, readyState = 'loading', hash = '') {
  const listeners = new Map<string, Set<Listener>>();
  const reloads: string[] = [];
  const href = `https://app.test/posts${hash}`;
  const sessionStorage =
    storage === null
      ? {
          getItem: (): never => {
            throw new DOMException('denied', 'SecurityError');
          },
          setItem: (): never => {
            throw new DOMException('denied', 'SecurityError');
          },
          removeItem: (): never => {
            throw new DOMException('denied', 'SecurityError');
          },
        }
      : {
          getItem: (key: string) => storage.get(key) ?? null,
          setItem: (key: string, value: string) => void storage.set(key, value),
          removeItem: (key: string) => void storage.delete(key),
        };
  const run = new Function(
    'addEventListener',
    'removeEventListener',
    'document',
    'location',
    'sessionStorage',
    STYLE_HEAL_BODY,
  );
  run(
    (type: string, fn: Listener) => listeners.set(type, (listeners.get(type) ?? new Set()).add(fn)),
    (type: string, fn: Listener) => listeners.get(type)?.delete(fn),
    { readyState },
    {
      href,
      hash,
      reload: () => reloads.push(`reload ${href}`),
      replace: (to: string) => reloads.push(`replace ${to}`),
    },
    sessionStorage,
  );
  const fire = (type: string, target: unknown = null): void => {
    for (const fn of [...(listeners.get(type) ?? [])]) fn({ target });
  };
  const sheet = { tagName: 'LINK', rel: 'stylesheet' };
  return { fire, reloads, sheet, listening: () => listeners.get('error')?.size ?? 0 };
}

describe('the stylesheet self-heal', () => {
  test('a stylesheet that fails while the page loads reloads once; the next load does not', () => {
    const storage = new Map<string, string>();
    const first = load(storage);
    first.fire('error', first.sheet);
    // A GET of the same URL, never `reload()`: a POST answered in place must not be re-sent.
    expect(first.reloads).toEqual(['replace https://app.test/posts']);
    const second = load(storage);
    second.fire('error', second.sheet);
    second.fire('load');
    expect(second.reloads).toEqual([]);
    expect(storage.get(STYLE_HEAL_KEY)).toBe('https://app.test/posts');
  });

  test('a clean load clears the marker, so the next skew on this page heals again', () => {
    const storage = new Map([[STYLE_HEAL_KEY, 'https://app.test/posts']]);
    load(storage).fire('load');
    expect(storage.has(STYLE_HEAL_KEY)).toBe(false);
    const next = load(storage);
    next.fire('error', next.sheet);
    expect(next.reloads).toHaveLength(1);
  });

  test('with a fragment, where the same URL would only scroll, it is a reload', () => {
    const page = load(new Map(), 'loading', '#comments');
    page.fire('error', page.sheet);
    expect(page.reloads).toEqual(['reload https://app.test/posts#comments']);
  });

  test('not a stylesheet, not while loading, no storage: never a reload', () => {
    const page = load(new Map());
    page.fire('error', { tagName: 'SCRIPT', rel: '' });
    page.fire('error', { tagName: 'LINK', rel: 'preload' });
    page.fire('error', null);
    page.fire('load');
    expect(page.listening()).toBe(0);
    page.fire('error', page.sheet);
    expect(page.reloads).toEqual([]);
    const loaded = load(new Map(), 'complete');
    expect(loaded.listening()).toBe(0);
    const locked = load(null);
    locked.fire('error', locked.sheet);
    expect(locked.reloads).toEqual([]);
  });

  test('the tag is the body, inline, with no handler attribute a policy would refuse', () => {
    expect(STYLE_HEAL_TAG).toBe(`<script>${STYLE_HEAL_BODY}</script>`);
    expect(STYLE_HEAL_TAG).not.toMatch(/\son\w+=/);
  });
});
