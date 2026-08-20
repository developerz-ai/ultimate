// The barrel is not inert: importing `@ultimat3/render` installs the `.tsx`/`.scss` Bun loader as
// a side effect, and that placement is the whole mechanism — a plugin only transforms modules
// loaded AFTER it, and an app's route file imports `defineRoute` from here before it imports
// anything of its own. Nothing imported this file, so the one guarantee the package makes at
// module scope was unmeasured.
//
// Every import here is DYNAMIC and the barrel comes first. A static `import` of a `.tsx` carrying
// `<>` is resolved before the plugin exists and caches a broken fragment transform for the rest of
// the process — which is exactly the failure the side effect exists to prevent.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

type Barrel = typeof import('./index');

let barrel: Barrel;
let dir = '';

beforeAll(async () => {
  // The import under test. Everything below is loaded after it, on purpose.
  barrel = await import('./index');
  // Inside the checkout, not the system temp dir: the loader's prelude imports
  // `@ultimat3/render`, and a file outside the workspace cannot resolve it. Outside `src/` so no
  // repo scanner reads a throwaway `.tsx` as source.
  dir = await mkdtemp(join(import.meta.dir, '..', '.barrel-fixture-'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('importing the barrel installs the render loader', () => {
  test('a .tsx module loaded afterwards compiles to the framework factory', async () => {
    const file = join(dir, 'probe.tsx');
    await writeFile(file, "export const node = <main class='probe'>hello</main>;\n");

    const loaded = (await import(file)) as { node: unknown };

    // Not "it loaded" — the NODE the framework's own `h` builds. Under Bun's default the same
    // source compiles to `React.createElement` against a global that does not exist.
    expect(barrel.isJsxNode(loaded.node)).toBe(true);
    expect(loaded.node).toEqual(barrel.h('main', { class: 'probe' }, 'hello'));
    expect((loaded.node as { type: unknown }).type).toBe('main');
  });

  test('a fragment compiles to the framework Fragment, not to a wrapper element', async () => {
    const file = join(dir, 'fragment.tsx');
    await writeFile(file, "export const node = <>{'a'}{'b'}</>;\n");

    const loaded = (await import(file)) as { node: unknown };

    expect((loaded.node as { type: unknown }).type).toBe(barrel.Fragment);
    // A fragment IS its children — rendering it must not introduce an element.
    expect(loaded.node).toEqual(barrel.h(barrel.Fragment, null, 'a', 'b'));
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

describe('the barrel re-exports the modules themselves, never copies', () => {
  test('the route primitive and the JSX factory are the same objects', async () => {
    const route = await import('./route');
    const jsx = await import('./jsx');
    // Identity matters here and is not pedantry: `h` is what the LOADER's prelude imports from
    // this package, so a barrel handing back a wrapper would give a route file a factory that
    // builds nodes `isJsxNode` does not recognise.
    expect(barrel.defineRoute).toBe(route.defineRoute);
    expect(barrel.h).toBe(jsx.h);
    expect(barrel.Fragment).toBe(jsx.Fragment);
    expect(barrel.isJsxNode).toBe(jsx.isJsxNode);
    expect(barrel.JSX_NODE).toBe(jsx.JSX_NODE);
  });

  test('the registry, the island primitive and the loader are the same objects', async () => {
    const registry = await import('./registry');
    const island = await import('./island');
    const loader = await import('./module-loader');
    expect(barrel.registerRoute).toBe(registry.registerRoute);
    expect(barrel.describeRoutes).toBe(registry.describeRoutes);
    expect(barrel.matchRoute).toBe(registry.matchRoute);
    expect(barrel.island).toBe(island.island);
    // The barrel calls this AND re-exports it — a host that installs it again must reach the same
    // `installed` flag, or `x dev` registers a second plugin over the first.
    expect(barrel.installRenderLoader).toBe(loader.installRenderLoader);
    expect(barrel.registeredStylesheets).toBe(loader.registeredStylesheets);
  });

  test('the four render modes each reach the barrel, and no fifth is exported', async () => {
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

    // The other half of the same promise, and the one this package got wrong: `renderSpa` and
    // `createRouter` were on the barrel with no implementation behind them — `renderSpa` never
    // read the route's component and shipped an empty `<div id="x-root">`, and `createRouter`
    // had no caller in the framework or in either tracked app. An exported name nothing
    // exercises is a promise `x routes` and the manifest both repeat.
    const surface = Object.keys(barrel);
    expect(surface).not.toContain('renderSpa');
    expect(surface).not.toContain('renderSpaShell');
    expect(surface).not.toContain('createRouter');
    expect(barrel.ROOT_ELEMENT_ID).toBe(html.ROOT_ELEMENT_ID);
  });

  test('the head renderer the wiki tells callers to use is present and is head.ts’s', async () => {
    // `wiki/Known-Gaps.md` names this pair as the ONE supported way to render a head, after
    // `@ultimat3/seo`'s weaker serializer was removed in 2.0.0.
    const head = await import('./head');
    expect(barrel.renderHead).toBe(head.renderHead);
    expect(barrel.headFromMeta).toBe(head.headFromMeta);
  });

  test('nothing is exported as undefined — a re-export of a renamed symbol is silent', async () => {
    // A `export { gone } from './x'` where `x` no longer exports `gone` is a build error, but a
    // barrel entry that resolves to `undefined` (a renamed const, a type/value mix-up) is not.
    const holes = Object.entries(barrel as Record<string, unknown>)
      .filter(([, value]) => value === undefined)
      .map(([name]) => name);
    expect(holes).toEqual([]);
    // And the surface is not accidentally empty.
    expect(Object.keys(barrel).length).toBeGreaterThan(50);
  });
});
