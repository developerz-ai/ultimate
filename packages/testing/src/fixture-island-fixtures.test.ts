// The compiled islands and the mount helper every `fixture-island*.test.ts` shares — one copy,
// split out on 2026-09-07 when the dispose cases pushed the suite past the 500-line ceiling.
import { UltimateError } from '@ultimat3/core';
import type { IslandBuilder } from './fixture-island';
import { mountIsland } from './fixture-island';

export const FILE = 'apps/web/site/counter.island.tsx';
export const ROOT = '/tmp/island-fixture-root';

/** A builder is a function of the app root — the seam `buildIslands` fills in a real app. */
export const builderOf = (chunks: readonly { file: string; code: string }[]): IslandBuilder => {
  return (root: string) => Promise.resolve({ chunks: root === ROOT ? chunks : [] });
};

/**
 * The markup half of a compiled island: a parsed `<template>`, cloned per mount. Written by hand
 * rather than generated, so this file states what the micro-DOM must support instead of inheriting
 * it from whatever the bundler happened to emit today.
 */
export const PRELUDE = `const _tmpl$ = (() => {
  const t = document.createElement('template');
  t.innerHTML = '<div class="zero"><button type="button" data-role="bump">go</button><p data-role="count"> </p></div>';
  return t.content.firstChild;
})();
`;

/** Reactive: every click repaints the text node, the class property and the document attribute. */
export const LIVE_ISLAND = `${PRELUDE}
export function mount(el, props) {
  el.textContent = '';
  const root = document.importNode(_tmpl$, true);
  const button = root.firstChild;
  const text = button.nextSibling.firstChild;
  let n = 0;
  const paint = () => {
    text.data = props.label + ' ' + n;
    root.className = n > 0 ? 'pos' : 'zero';
    if (n === 0) delete document.documentElement.dataset.clicked;
    else document.documentElement.dataset.clicked = String(n);
  };
  button.$$click = () => { n += 1; paint(); };
  paint();
  el.appendChild(root);
}
`;

/**
 * The same island with the repaint dropped from the handler: it renders once, correctly, and never
 * updates again — no throw, no log. That is the failure an eager JSX factory produces, and a
 * fixture that cannot tell it from LIVE_ISLAND proves nothing about any island.
 */
export const DEAD_ISLAND = LIVE_ISLAND.replace('() => { n += 1; paint(); }', '() => { n += 1; }');

export const POSTING_ISLAND = `export function mount(el, props) {
  el.textContent = '';
  const p = document.createElement('p');
  p.setAttribute('data-role', 'status');
  p.textContent = 'idle';
  el.appendChild(p);
  p.$$click = () => {
    fetch(props.endpoint, { method: 'POST', body: '{}' }).then((r) => {
      p.textContent = r.ok ? 'saved' : 'retry';
    });
  };
}
`;

/**
 * `solid-js/web`'s own `setStyleProperty`, verbatim (`web.js:302`). It is what
 * `babel-preset-solid` emits for every DYNAMIC entry of a `style={{ … }}` prop — checked against
 * the real transform, which turns `<Form style={{ '--form-gap': … }}>` into exactly this call and
 * bakes a static entry into the template's `style` attribute instead.
 */
export const SET_STYLE_PROPERTY = `const setStyleProperty = (node, name, value) => {
  value != null ? node.style.setProperty(name, value) : node.style.removeProperty(name);
};
`;

/**
 * What a design-system component compiles to: one custom property painted per repaint, one
 * `classList.toggle` — the call the compiler emits INLINE for `classList={{ … }}`, with no runtime
 * helper in front of it — and one static declaration carried by the template.
 */
export const STYLED_ISLAND = `${SET_STYLE_PROPERTY}
export const _tmpl$ = (() => {
  const t = document.createElement('template');
  t.innerHTML = '<form class="form" style="display:grid"><button type="button" data-role="gap">go</button></form>';
  return t.content.firstChild;
})();

export function mount(el, props) {
  el.textContent = '';
  const root = document.importNode(_tmpl$, true);
  const button = root.firstChild;
  let step = props.gap;
  const paint = () => {
    setStyleProperty(root, '--form-gap', step === null ? null : 'var(--space-' + step + ')');
    root.classList.toggle('tight', step === 2);
  };
  button.$$click = () => { step = step === 5 ? 2 : null; paint(); };
  paint();
  el.appendChild(root);
}
`;

/** The other half of Solid's `style` runtime: a STRING style prop is `nodeStyle.cssText = value`,
 *  and clearing one is `setAttribute(node, 'style')` — which is `removeAttribute` (`web.js:237`). */
export const CSS_TEXT_ISLAND = `export function mount(el, props) {
  el.textContent = '';
  const box = document.createElement('div');
  box.setAttribute('data-role', 'box');
  box.style.cssText = props.css;
  box.$$click = () => { box.removeAttribute('style'); };
  el.appendChild(box);
}
`;

/**
 * An ASYNC mount, the shape `like.island.tsx` already ships: `await OfflineQueue.open(store)` before
 * the first render, so a click can never be handed a client whose queue has not rehydrated. The
 * await here is a MACROTASK on purpose — the incidental microtask turns of `await mountIsland(…)`
 * would otherwise let a one-tick mount finish by accident, and a test that passes by accident is
 * the reason this hole survived.
 */
export const ASYNC_ISLAND = `export async function mount(el, props) {
  el.textContent = '';
  const queue = await openQueue();
  const p = document.createElement('p');
  p.setAttribute('data-role', 'state');
  p.textContent = queue.depth + ' ' + props.label;
  p.$$click = () => { p.textContent = 'clicked'; };
  el.appendChild(p);
}
`;

/** `@ultimat3/ui`'s Menu, Popover and focus trap all close on Escape from a listener registered on
 *  `document` (`packages/ui/src/a11y.ts:118`), never on their own node. */
export const ESCAPABLE_ISLAND = `export function mount(el) {
  el.textContent = '';
  const p = document.createElement('p');
  p.setAttribute('data-role', 'state');
  p.textContent = 'open';
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') p.textContent = 'closed';
  });
  el.appendChild(p);
}
`;

/**
 * An island that keeps running after `mount` returns — a dashboard that polls, a console that
 * ticks. Solid's `render` answers a disposer, and `return render(…)` is the one line that lets a
 * fixture stop it: a disposed root runs every `onCleanup`. This one is hand-written for the same
 * reason the others are, and holds its interval the way a Solid root would hold its cleanup. The
 * `setInterval` it calls is whatever the mount's `globals` say — `fakeIntervals()` below — so a
 * test drives each tick by hand and asserts the disposer cleared the timer, never waits for one.
 */
export const TICKING_ISLAND = `export function mount(el, props) {
  el.textContent = '';
  const counter = ticks;
  const id = setInterval(() => {
    counter.n += 1;
    document.documentElement.dataset.ticks = String(counter.n);
  }, 1);
  return () => clearInterval(id);
}
`;

/**
 * `setInterval` / `clearInterval` the test drives by hand, handed to the island through the
 * fixture's `globals` — the seam it already has for `fetch`, and `installGlobals` assigns onto
 * `globalThis`, so a chunk's bare `setInterval(…)` resolves to these for the life of the mount.
 * Deterministic on purpose: the dispose test used to poll a real 1ms interval with `Bun.sleep`
 * and then sleep 25ms more to see it stay quiet, which is a test that fails under load and
 * passes without proving the timer transition it is named for. Here a tick is a call, and
 * "the disposer cleared the interval" is `armed() === 0` — the exact `clearInterval(id)` the
 * island returned, or nothing.
 */
export const fakeIntervals = (): {
  readonly globals: Readonly<Record<string, unknown>>;
  /** Run every armed callback once — one tick of a clock the island never sees. */
  tick(): void;
  /** How many intervals are live: `1` after mount, `0` once the disposer ran. */
  armed(): number;
} => {
  const live = new Map<number, () => void>();
  let next = 1;
  const setInterval = (callback: () => void): number => {
    const id = next;
    next += 1;
    live.set(id, callback);
    return id;
  };
  const clearInterval = (id: number): void => {
    live.delete(id);
  };
  return {
    globals: { setInterval, clearInterval },
    tick: () => {
      for (const callback of [...live.values()]) callback();
    },
    armed: () => live.size,
  };
};

export const mount = (code: string, props: unknown, extra: Record<string, unknown> = {}) =>
  mountIsland({
    build: builderOf([{ file: FILE, code }]),
    root: ROOT,
    file: FILE,
    props,
    ...extra,
  });

export const codeOf = (error: unknown): string =>
  error instanceof UltimateError ? error.code : `not an UltimateError: ${String(error)}`;
