// The build-time barrel is not inert: importing `@ultimat3/render/server` installs the
// `.tsx`/`.scss` Bun loader as a side effect, and that placement is the whole mechanism — a plugin
// only transforms modules loaded AFTER it. It moved here from `@ultimat3/render` in the `"."` /
// `"./server"` split, because the loader pulls `sass` and `node:url` and no browser bundle may.
//
// Every import here is DYNAMIC and the barrel comes first. A static `import` of a `.tsx` carrying
// `<>` is resolved before the plugin exists and caches a broken fragment transform for the rest of
// the process — which is exactly the failure the side effect exists to prevent.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

type ServerBarrel = typeof import('./server');

let barrel: ServerBarrel;
let dir = '';

beforeAll(async () => {
  // The import under test. Everything below is loaded after it, on purpose.
  barrel = await import('./server');
  // Inside the checkout, not the system temp dir: the loader's prelude imports
  // `@ultimat3/render`, and a file outside the workspace cannot resolve it. Outside `src/` so no
  // repo scanner reads a throwaway `.tsx` as source.
  dir = await mkdtemp(join(import.meta.dir, '..', '.server-fixture-'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('importing the server barrel installs the render loader', () => {
  test('a .tsx module loaded afterwards compiles to the framework factory', async () => {
    const file = join(dir, 'probe.tsx');
    await writeFile(file, "export const node = <main class='probe'>hello</main>;\n");

    const loaded = (await import(file)) as { node: unknown };
    const jsx = await import('./jsx');

    // Not "it loaded" — the NODE the framework's own `h` builds. Under Bun's default the same
    // source compiles to `React.createElement` against a global that does not exist.
    expect(jsx.isJsxNode(loaded.node)).toBe(true);
    expect(loaded.node).toEqual(jsx.h('main', { class: 'probe' }, 'hello'));
    expect((loaded.node as { type: unknown }).type).toBe('main');
  });

  test('a fragment compiles to the framework Fragment, not to a wrapper element', async () => {
    const file = join(dir, 'fragment.tsx');
    await writeFile(file, "export const node = <>{'a'}{'b'}</>;\n");

    const loaded = (await import(file)) as { node: unknown };
    const jsx = await import('./jsx');

    expect((loaded.node as { type: unknown }).type).toBe(jsx.Fragment);
    // A fragment IS its children — rendering it must not introduce an element.
    expect(loaded.node).toEqual(jsx.h(jsx.Fragment, null, 'a', 'b'));
  });

  test('a .scss module loaded afterwards registers its css and exports its class map', async () => {
    const file = join(dir, 'probe.module.scss');
    await writeFile(file, '.card { color: red; }\n');

    const loaded = (await import(file)) as { default: Record<string, string> };

    // The default export is the scoped class map, which is what `import styles from` receives.
    expect(Object.keys(loaded.default)).toEqual(['card']);
    expect(loaded.default['card']).not.toBe('card');
    // …and the compiled css reached the registry the document builder reads.
    const registered = barrel.registeredStylesheets().find((sheet) => sheet.file === file);
    expect(registered?.css).toContain(loaded.default['card'] as string);
    expect(registered?.css).toContain('red');
  });
});

describe('the server barrel re-exports the modules themselves, never copies', () => {
  test('the loader is the same object the barrel already called', async () => {
    const loader = await import('./module-loader');
    // The barrel calls this AND re-exports it — a host that installs it again must reach the same
    // `installed` flag, or `x dev` registers a second plugin over the first.
    expect(barrel.installRenderLoader).toBe(loader.installRenderLoader);
    expect(barrel.registeredStylesheets).toBe(loader.registeredStylesheets);
    expect(barrel.stylesFor).toBe(loader.stylesFor);
  });

  test('the four render modes each reach this barrel, and no fifth is exported', async () => {
    // One entry point per mode: the package's headline promise is that a route declares a mode
    // and the framework owns the rest, so a mode missing from the surface is a mode an app
    // cannot use however well it is implemented.
    const html = await import('./render-html');
    const isr = await import('./render-isr');
    const ssr = await import('./render-ssr');
    const staticMode = await import('./render-static');
    expect(barrel.renderToHtml).toBe(html.renderToHtml);
    expect(barrel.createIsrController).toBe(isr.createIsrController);
    expect(barrel.renderSsr).toBe(ssr.renderSsr);
    expect(barrel.renderStatic).toBe(staticMode.renderStatic);
    expect(barrel.ROOT_ELEMENT_ID).toBe(html.ROOT_ELEMENT_ID);

    // The other half of the same promise, and the one this package got wrong: `renderSpa` and
    // `createRouter` were on a barrel with no implementation behind them.
    const surface = Object.keys(barrel);
    expect(surface).not.toContain('renderSpa');
    expect(surface).not.toContain('renderSpaShell');
    expect(surface).not.toContain('createRouter');
  });

  test('nothing is exported as undefined — a re-export of a renamed symbol is silent', () => {
    const holes = Object.entries(barrel as Record<string, unknown>)
      .filter(([, value]) => value === undefined)
      .map(([name]) => name);
    expect(holes).toEqual([]);
    expect(Object.keys(barrel).length).toBeGreaterThan(20);
  });
});
