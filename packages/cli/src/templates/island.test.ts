// The three facts a scaffolded island cannot get wrong: the filename the bundler discovers it by,
// the `mount` export the hydration runtime calls, and that mount RENDERS — reactively. The first
// two are string assertions; the third is the emitted file built by `buildIslands` and driven by
// `mountIsland`, because a template that typechecks and does not mount is the same bug one step
// quieter, and that is exactly what shipped through five majors.

import { describe, expect, test } from 'bun:test';
import { mountIsland } from '@ultimat3/testing';
import { buildIslands } from '../island-bundle';
import { islandFiles } from './island';
import { fixtureAppRoot } from './island-fixture';

const filesFor = (name: string, dir = 'apps/web/site/pricing'): readonly string[] =>
  islandFiles(name, { dir }).map((file) => file.path);

const sourceOf = (name: string): string =>
  String(islandFiles(name, { dir: 'apps/web/site' })[0]?.contents ?? '');

const DIR = 'apps/web/app/demo';
const ENTRY = `${DIR}/counter.island.tsx`;

describe('unit · x g island', () => {
  test('the entry carries the one extension the bundler discovers a client entry by', () => {
    expect(filesFor('currency-picker')).toEqual([
      'apps/web/site/pricing/currency-picker.island.tsx',
      'apps/web/site/pricing/currency-picker.module.scss',
      // The states file ships WITH the entry: `x verify`'s `boundaries` step refuses an island that
      // declares none (`guards/island-without-states.ts`), so a generator that wrote only the
      // component would scaffold a file that fails the app's own gate on the next command.
      'apps/web/site/pricing/currency-picker.island.states.ts',
      'apps/web/site/pricing/currency-picker.island.test.ts',
    ]);
  });

  test('a camelCase or spaced name still lands on a kebab filename', () => {
    // The filename becomes the moduleId in the HTML, the chunk URL and the budget report, so a
    // second casing here would be three surfaces disagreeing about one island's name.
    expect(filesFor('CurrencyPicker')[0]).toBe('apps/web/site/pricing/currency-picker.island.tsx');
  });

  test('a trailing slash on --at does not produce a doubled path segment', () => {
    expect(filesFor('counter', 'apps/web/site/pricing/')[0]).toBe(
      'apps/web/site/pricing/counter.island.tsx',
    );
  });

  test('the entry exports mount, and shows the island() line that names it', () => {
    const source = sourceOf('counter');
    expect(source).toContain('export function mount(');
    // The declaration goes on the PAGE, so the scaffold has to say so — an island file that looks
    // self-registering is an island nothing ever renders.
    expect(source).toContain("island({ src: './counter.island.tsx'");
  });

  // Its own case, because the guard above is a text scan and this file is IMPORTED by `x shot`:
  // one non-type import of the component and `assertIslandStatesPure` refuses the whole manifest.
  test('the states file names the island it belongs to, and imports it as a type', () => {
    const states = String(
      islandFiles('counter', { dir: DIR }).find((file) => file.path.endsWith('.island.states.ts'))
        ?.contents ?? '',
    );
    expect(states).toContain(`island: '${ENTRY}'`);
    expect(states).toContain("import type { CounterProps } from './counter.island'");
    expect(states).not.toContain("from 'solid-js'");
  });

  test('the emitted test names the island app-root-relative, as discoverIslands reports it', () => {
    // By SUFFIX, never by index: a fourth emitted file moved the test one slot along and the
    // assertion then read the states file, which passed nothing and named nothing.
    const spec = String(
      islandFiles('counter', { dir: DIR }).find((file) => file.path.endsWith('.island.test.ts'))
        ?.contents ?? '',
    );
    // The entry is the MANIFEST's — one spelling of the path, in the states file — and each state
    // is mounted from its declared props, so the picture and the test are of one component.
    expect(spec).toContain("import { counterStates } from './counter.island.states';");
    // No path and no props in the test at all: `describeIslandState` reads both off the manifest.
    expect(spec).not.toContain('counter.island.tsx');
    expect(spec).not.toContain('props:');
    const states = String(
      islandFiles('counter', { dir: DIR }).find((file) => file.path.endsWith('.island.states.ts'))
        ?.contents ?? '',
    );
    expect(states).toContain(`island: '${ENTRY}'`);
    // Every state the manifest declares is one the test mounts — a state nothing mounts is a
    // states file no unit test loads, which is uncovered source under the app's coverage floor.
    for (const id of ['idle', 'long-label']) {
      expect(states).toContain(`id: '${id}'`);
      expect(spec).toContain(`describeIslandState(counterStates, '${id}', island, (mounted) => {`);
    }
    // One `..` per directory segment. A miscounted root is a test that reports the island was
    // never built, naming a file the author can see on disk.
    expect(spec).toContain("join(import.meta.dir, '..', '..', '..', '..')");
  });
});

describe('unit · the island x g island emits actually mounts', () => {
  test('it replaces the shell, and a click reaches the DOM', async () => {
    using root = await fixtureAppRoot('island', islandFiles('counter', { dir: DIR }));
    using mounted = await mountIsland({
      build: buildIslands,
      root: root.path,
      file: ENTRY,
      props: { label: 'Open' },
      shell: '<span>server</span>',
    });

    expect(mounted.find('span')).toBeNull();
    // A chunk that fell back to the classic React factory names a global that is not in it, and
    // `Bun.build` answers `success: true` over that all the same.
    expect(mounted.code).not.toMatch(/\bReact\b/);
    expect(mounted.text('[data-role="count"]')).toBe('0');
    expect(mounted.fire('button', 'click')).toBe(true);
    expect(mounted.text('[data-role="count"]')).toBe('1');
  }, 60_000);

  // The mutation, run rather than described: break the one thing the case above is for — the
  // signal read that reaches the DOM — and the assertion must notice. A test that cannot fail is
  // not a test, and this is the half of that claim a reader can check.
  test('a count that never re-reads the signal fails the same assertion', async () => {
    const emitted = islandFiles('counter', { dir: DIR }).map((file) =>
      file.path === ENTRY
        ? { ...file, contents: String(file.contents).replace('{count()}', '{0}') }
        : file,
    );
    using root = await fixtureAppRoot('island-inert', emitted);
    using mounted = await mountIsland({
      build: buildIslands,
      root: root.path,
      file: ENTRY,
      props: { label: 'Open' },
    });

    expect(mounted.fire('button', 'click')).toBe(true);
    // The EXACT text, never `not.toBe('1')`: `text()` answers `''` for a selector that matches
    // nothing, so the negative form also passes for an island whose output node vanished — a
    // mutation test that cannot tell a dead signal from a dead assertion.
    expect(mounted.text('[data-role="count"]')).toBe('0');
  }, 60_000);

  // Plan 101 sweep 11 I5: a render that throws must leave the server's markup on screen, not a
  // blank box. Real Solid, built: the emitted component is made to throw, and `mount` is wrapped
  // so the throw is OBSERVED here instead of failing the mount — the runtime's `boot` is what
  // catches it in a browser and marks the root `data-x-failed` for the error reporter.
  test('a component that throws leaves the server shell in place, and the throw reaches boot', async () => {
    const emitted = islandFiles('counter', { dir: DIR }).map((file) =>
      file.path === ENTRY
        ? {
            ...file,
            contents: `${String(file.contents)
              .replace(
                'const [count, setCount] = createSignal(0);',
                "const [count, setCount] = createSignal(0);\n  if (count() === 0) throw new RangeError('render threw');",
              )
              .replace('export function mount(', 'function drawn(')}
export function mount(el: HTMLElement, props: CounterProps): () => void {
  try {
    return drawn(el, props);
  } catch (error) {
    el.setAttribute('data-caught', error instanceof Error ? error.message : 'unknown');
    return () => undefined;
  }
}
`,
          }
        : file,
    );
    using root = await fixtureAppRoot('island-throws', emitted);
    using mounted = await mountIsland({
      build: buildIslands,
      root: root.path,
      file: ENTRY,
      props: { label: 'Open' },
      shell: '<span>server</span>',
    });

    expect(mounted.el.getAttribute('data-caught')).toBe('render threw');
    expect(mounted.text('span')).toBe('server');
    expect(mounted.find('button')).toBeNull();
  }, 60_000);
});
