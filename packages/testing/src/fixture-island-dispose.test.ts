// The island fixture DISPOSES what it mounted, and imports its chunk from a file — split out of
// `fixture-island.test.ts` on 2026-09-07 (the 500-line ceiling). Fixtures are shared.
// The fixture's own contract, against modules written in the exact idiom `babel-preset-solid`
// emits — a `<template>` whose `innerHTML` is parsed, `importNode`, a `firstChild`/`nextSibling`
// walk, a text node updated through `.data`, and a delegated `$$click`. No bundler and no Solid
// runtime here on purpose: `@ultimat3/testing` cannot import `@ultimat3/cli` (both tier 5, and the
// one declared edge runs the other way), and the whole-chain proof — real Babel, real Solid, a
// real island — is `examples/dummy/apps/web/app/settings/settings.island.test.ts`.

import { describe, expect, test } from 'bun:test';
import { LIVE_ISLAND, mount, TICKING_ISLAND, until } from './fixture-island-fixtures.test';
import { testName } from './test-types';

describe(testName('unit', 'the island fixture disposes what it mounted'), () => {
  /**
   * Restoring the globals was the whole of the teardown until 2026-09-07, so an island whose
   * `mount` started an interval kept ticking after the DOM was gone. Measured in ai-maxxing as
   * "Unhandled error between tests: `document is not defined`" — the tick reading a `document`
   * the fixture had already taken back — and as a fetch stub in one file receiving POSTs from
   * another file's island.
   */
  test('dispose runs the disposer mount returned — an interval stops with the DOM', async () => {
    const counter = { n: 0 };
    {
      using mounted = await mount(TICKING_ISLAND, {}, { globals: { ticks: counter } });
      await until(() => counter.n >= 2);
      expect(mounted.documentElement.dataset['ticks']).toBe(String(counter.n));
    }
    const atDispose = counter.n;
    await Bun.sleep(25);

    // Before the fix the count went on climbing here, and every tick threw into whichever test
    // happened to be running by then.
    expect(counter.n).toBe(atDispose);
  });

  test('the disposer runs BEFORE the globals go back — it sees the document mount saw', async () => {
    let sawDocument: boolean | undefined;
    const observe = (value: boolean): void => {
      sawDocument = value;
    };
    {
      using mounted = await mount(
        `export function mount(el) {
  el.textContent = '';
  return () => { observe(typeof document !== 'undefined'); };
}
`,
        {},
        { globals: { observe } },
      );
      void mounted;
    }

    // A disposer clears an interval whose callback reads `document`, or removes a listener from
    // it: run after the restore, that is the same `document is not defined` one call later.
    expect(sawDocument).toBe(true);
  });

  test('a disposer that throws still hands the globals back, and the throw reaches the test', async () => {
    const before = Reflect.get(globalThis, 'document');
    const mounted = await mount(
      'export function mount(el) { el.textContent = ""; return () => { throw new TypeError("boom"); }; }\n',
      {},
    );

    expect(() => mounted[Symbol.dispose]()).toThrow('boom');
    expect(Reflect.get(globalThis, 'document')).toBe(before);
  });

  test('a mount that returns nothing disposes as it always did', async () => {
    const before = Reflect.get(globalThis, 'document');
    {
      using mounted = await mount(LIVE_ISLAND, { label: 'count' });
      void mounted;
    }
    expect(Reflect.get(globalThis, 'document')).toBe(before);
  });
});

/**
 * The micro-DOM's write surfaces, driven the way compiled Solid drives them. `style` was `{}` and
 * `classList` was `{ add() {} }` until 2026-08-21: `<Form>`, `<Stack>`, `<Grid>` and `<Container>`
 * all set a CSS custom property, so every one of them died inside `mount` with
 * `e.style.setProperty is not a function` — and `x g resource` emitted a plain `<form>` rather than
 * the design system's, because of what a TEST DOUBLE could not run.
 */
describe(testName('unit', 'the chunk is imported from a file, never a data: URL'), () => {
  // A source rule, because the failure it guards is invisible to `bun test`: `bun test --coverage`
  // panics with `range end index N out of range for slice of length 4096` on `import()` of any
  // `data:` module over ~4 kB, and every island chunk is 12-55 kB. Only the per-package CI job runs
  // coverage, so the whole suite went green locally while `package (cli)` and `package (testing)`
  // dumped core. The `data:` form reads better and is the one to reach for again; this is what says
  // no. Measured on Bun 1.4.0 — delete this the day that panic is fixed upstream.
  const source = (): Promise<string> => Bun.file(`${import.meta.dir}/fixture-island.ts`).text();

  test('the module specifier the fixture builds is a path', async () => {
    expect(await source()).not.toContain('data:text/javascript');
  });

  test('and the pattern that would see it is really in the file to be seen', async () => {
    // Negative control: a rule matching a string no version of the file ever held cannot fail.
    expect(await source()).toContain('modulePathFor');
  });
});
