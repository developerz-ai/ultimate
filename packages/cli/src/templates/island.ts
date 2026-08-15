// `x g island <name>` — the one file on a route that ships JavaScript. Not a ninth primitive and
// not a component generator: an island is a client ENTRY POINT, so what the scaffold has to get
// right is the filename (the bundler discovers by it) and the `mount` export (the hydration
// runtime calls it by name). Both are pinned by the emitted test.

import type { GeneratedFile } from './naming';
import { kebab, pascal } from './naming';

export interface IslandOptions {
  /** Directory the entry lands in, app-root-relative and POSIX — normally a route's own folder. */
  readonly dir: string;
}

const islandSource = (name: string): string => {
  const Name = pascal(name);
  return `// ${Name}: the interactive half of an otherwise static page, and the only module on this
// route the browser downloads.
//
// The page names this file by SPECIFIER, never by import:
//   const ${Name} = island({ src: './${name}.island.tsx', props: ['label'] });
// A string has no import edge, so nothing follows one into this file and the page's bundle graph
// stays the page's (axiom 6). WHEN it wakes is the route's \`hydrate\`, never a declaration here.

/** What the server sends. Declared here AND in the page's \`island({ props })\` — both, or neither. */
export interface ${Name}Props {
  /** Already translated: this runs in the browser, where \`t()\`'s catalog is not. */
  readonly label: string;
}

/**
 * The one export the hydration runtime calls — \`import(entry).then((m) => m.mount(el, props))\`.
 * \`el\` is the wrapper the page rendered, with the server's own markup already inside it, so a
 * mount that replaces the markup instead of taking it over is a visible flash on every load.
 */
export function mount(el: HTMLElement, props: ${Name}Props): void {
  el.textContent = props.label;
  el.addEventListener('click', () => {
    el.dataset['open'] = el.dataset['open'] === 'true' ? 'false' : 'true';
  });
}
`;
};

const islandTest = (name: string): string => `import { expect, unitTest } from '@ultimat3/testing';
import * as entry from './${name}.island';

// The runtime boots an island by calling \`mount\` on whatever the module exports. A renamed or
// deleted export is a page that renders, serves, passes every other gate and does nothing when
// clicked — which is exactly the failure nothing else in the build can see.
unitTest('${name}.island exports the mount the hydration runtime calls', () => {
  expect(typeof entry.mount).toBe('function');
});
`;

export function islandFiles(rawName: string, options: IslandOptions): readonly GeneratedFile[] {
  const name = kebab(rawName);
  const dir = options.dir.replace(/\/+$/, '');
  return [
    { path: `${dir}/${name}.island.tsx`, contents: islandSource(name) },
    { path: `${dir}/${name}.island.test.ts`, contents: islandTest(name) },
  ];
}
