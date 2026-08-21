// `x g resource` emits a client entry, and this is what proves it is one. The form it used to emit
// was an ordinary `.tsx` with `createSignal`, `onSubmit` and `onInput` that no build ever compiled
// for a browser — server-rendered it loses every `on*` prop and reads each signal once, and nothing
// in the app imported it at all. So the assertions here are the ones a string test cannot make:
// the chunk builds, `mount` renders, the field tracks, and the submit posts what was typed.

import { describe, expect, test } from 'bun:test';
import { mountIsland } from '@ultimat3/testing';
import { buildIslands } from '../island-bundle';
import { fixtureAppRoot } from './island-fixture';
import { names } from './naming';
import { formIslandFiles } from './resource-form-island';

const DIR = 'apps/web/app/invoice';
const ENTRY = `${DIR}/invoice-form.island.tsx`;
const ENDPOINT = '/api/invoice/create-invoice';
const LABELS = { title: 'Title', submit: 'Save', saved: 'Saved', retry: 'Try again' };
const PROPS = { endpoint: ENDPOINT, locale: 'en', labels: LABELS };

const emitted = (): readonly { path: string; contents: string }[] =>
  formIslandFiles(names('invoice'), DIR).map((file) => ({
    path: file.path,
    contents: String(file.contents),
  }));

/** The slice's own stylesheet, which the form island imports. `x g resource` writes it; this test
 *  builds the island alone, so it supplies the one file the entry reaches outside its own. */
const withStylesheet = (
  files: readonly { path: string; contents: string }[],
): readonly { path: string; contents: string }[] => [
  ...files,
  { path: `${DIR}/ui.module.scss`, contents: '.item {\n  padding: 1rem;\n}\n' },
];

const fetchStub = (
  calls: { url: string; body: unknown }[],
  ok = true,
): Readonly<Record<string, unknown>> => ({
  fetch: (url: string, init: { body: string }): Promise<{ ok: boolean }> => {
    calls.push({ url, body: JSON.parse(init.body) as unknown });
    return Promise.resolve({ ok });
  },
});

describe('unit · x g resource emits its form as a client entry', () => {
  test('the two files are the island and its own mounting test', () => {
    expect(emitted().map((file) => file.path)).toEqual([
      `${DIR}/invoice-form.island.tsx`,
      `${DIR}/invoice-form.island.test.ts`,
    ]);
  });

  test('the entry registers the Solid runtime before it renders anything', () => {
    const source = emitted()[0]?.contents ?? '';
    // Order is the whole assertion: `<UiProvider>` reads the registration at render time, so a
    // `setSolidRuntime` below the `render()` call is a line that exists and never runs in time.
    expect(source.indexOf('setSolidRuntime(solidRuntime)')).toBeGreaterThan(-1);
    expect(source.indexOf('setSolidRuntime(solidRuntime)')).toBeLessThan(source.indexOf('render('));
  });
});

describe('unit · the form x g resource emits actually mounts', () => {
  test('it replaces the shell, tracks the field and posts what was typed', async () => {
    const calls: { url: string; body: unknown }[] = [];
    using root = await fixtureAppRoot('resource-form', withStylesheet(emitted()));
    using mounted = await mountIsland({
      build: buildIslands,
      root: root.path,
      file: ENTRY,
      props: PROPS,
      shell: '<article>server</article>',
      globals: fetchStub(calls),
    });

    expect(mounted.find('article')).toBeNull();
    expect(mounted.code).not.toMatch(/\bReact\b/);

    const field = mounted.find('input');
    expect(field).not.toBeNull();
    if (field !== null) field.value = 'First invoice';
    // `false` means no handler ran — an island whose onInput never reached the DOM is
    // indistinguishable from a selector typo otherwise.
    expect(mounted.fire(field, 'input')).toBe(true);
    expect(mounted.fire('form', 'submit', { preventDefault: (): void => {} })).toBe(true);
    await Promise.resolve();

    expect(calls).toEqual([{ url: ENDPOINT, body: { title: 'First invoice' } }]);
    // The signal reached the DOM: an eager JSX factory renders '' here and never runs again.
    expect(mounted.text('[data-role="status"]')).toBe(LABELS.saved);
  }, 60_000);

  // The mutation, run rather than described. `setSolidRuntime` had zero non-test callers when this
  // template was written (issue #246), so the line most likely to be "tidied away" is the one that
  // makes the rest work — and what it must produce when it goes is the CODE, not a stack trace.
  test('deleting setSolidRuntime from the entry throws X_UI_RUNTIME_MISSING', async () => {
    const mutated = withStylesheet(emitted()).map((file) =>
      file.path === ENTRY
        ? { ...file, contents: file.contents.replace('setSolidRuntime(solidRuntime);', '') }
        : file,
    );
    using root = await fixtureAppRoot('resource-form-no-runtime', mutated);

    await expect(
      mountIsland({ build: buildIslands, root: root.path, file: ENTRY, props: PROPS }),
    ).rejects.toBeUltimateError('X_UI_RUNTIME_MISSING');
  }, 60_000);
});
