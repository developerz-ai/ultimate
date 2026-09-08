// `x g island <name>` — the one file on a route that ships JavaScript. Not a ninth primitive and
// not a component generator: an island is a client ENTRY POINT, so what the scaffold has to get
// right is the filename (the bundler discovers by it), the `mount` export (the hydration runtime
// calls it by name) and what `mount` DOES — Solid's `render`, the one client shape the island build
// compiles. All three are pinned by the emitted test, which builds the chunk and mounts it.

import type { GeneratedFile } from './naming';
import { camel, kebab, pascal } from './naming';

export interface IslandOptions {
  /** Directory the entry lands in, app-root-relative and POSIX — normally a route's own folder. */
  readonly dir: string;
}

/**
 * `join(import.meta.dir, '..', …)` back to the app root, one hop per directory segment. The
 * emitted test names the island app-root-relative because that is how `discoverIslands` reports it,
 * so the two spellings have to agree or `mountIsland` reports a file it did not build.
 */
export const upToAppRoot = (dir: string): string =>
  dir
    .split('/')
    .filter((part) => part.length > 0)
    .map(() => "'..'")
    .join(', ');

const islandSource = (name: string): string => {
  const Name = pascal(name);
  return `// ${Name}: the interactive half of an otherwise static page, and the only module on this
// route the browser downloads.
//
// The page names this file by SPECIFIER, never by import:
//   const ${Name} = island({ src: './${name}.island.tsx', props: ['label'] });
// A string has no import edge, so nothing follows one into this file and the page's bundle graph
// stays the page's (axiom 6). WHEN it wakes is the route's \`hydrate\`, never a declaration here.

import type { JSX } from 'solid-js';
import { createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import styles from './${name}.module.scss';

/** What the server sends. Declared here AND in the page's \`island({ props })\` — both, or neither. */
export interface ${Name}Props {
  /** Already translated: this runs in the browser, where \`t()\`'s catalog is not. */
  readonly label: string;
}

/**
 * Solid, and not hand-written DOM: reactivity is a COMPILE-time contract that \`babel-preset-solid\`
 * fulfils inside the island build, which is what makes \`count()\` read below update that one text
 * node and nothing around it. A component written against an eager JSX factory reads every signal
 * once and never again — it renders, and then it is a photograph.
 */
function ${Name}(props: ${Name}Props): JSX.Element {
  const [count, setCount] = createSignal(0);
  return (
    <p class={styles.panel}>
      <button type="button" class={styles.trigger} onClick={() => setCount(count() + 1)}>
        {props.label}
      </button>
      <output data-role="count">{count()}</output>
    </p>
  );
}

/**
 * The one export the hydration runtime calls — \`import(entry).then((m) => m.mount(el, props))\`.
 * \`el\` is the wrapper the page rendered, with the server's own markup already inside it.
 *
 * The shell is cleared first, and that line is load-bearing: Solid's \`render\` APPENDS when the
 * container already has children, so without it the server's markup stays on screen above a
 * second, live copy of the same thing.
 */
export function mount(el: HTMLElement, props: ${Name}Props): () => void {
  el.textContent = '';
  // Solid's \`render\` answers its disposer; returning it is what lets \`mountIsland\` in
  // \`@ultimat3/testing\` stop this island — its timers included — when a test is done with it.
  return render(() => <${Name} {...props} />, el);
}
`;
};

const islandStyle =
  (): string => `// Semantic tokens only — a raw hex here is refused by the boundaries step, not by lint — a dark-theme bug and
// a lint failure. Scoped by the island build, with the class names the server hashed.
@use '@ultimat3/ui/tokens' as tokens;

.panel {
  display: flex;
  align-items: center;
  gap: tokens.space(2);
}

.trigger {
  padding: tokens.space(2);
  border-radius: tokens.radius('sm');
  background: tokens.role('surface-raised');
  color: tokens.role('fg');
}
`;

const islandTest = (
  name: string,
  dir: string,
): string => `// The island the browser actually runs. \`mountIsland\` builds this entry with the same
// \`buildIslands\` that \`x build\` and \`x dev\` use, imports the emitted chunk the way the hydration
// runtime does, and drives \`mount\` against a DOM small enough to read.
//
// Importing the module and asserting \`typeof mount === 'function'\` proves the file exists, and a
// file that exists is exactly what ships dead: a renamed export, a dropped handler and a signal
// that never reaches the DOM all pass that test and none of them survive this one.

import { join } from 'node:path';
import { buildIslands } from '@ultimat3/cli';
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  type MountedIsland,
  mountIsland,
  test,
} from '@ultimat3/testing';

const APP_ROOT = join(import.meta.dir, ${upToAppRoot(dir)});
const ISLAND = '${dir}/${name}.island.tsx';

let mounted: MountedIsland;

// The build is a Babel pass plus a browser bundle — seconds, not milliseconds. It lives in
// \`beforeAll\` with its own timeout because \`test\` takes no third argument: fixtures are resolved
// per case, so the slow work goes where it can be given one and every case shares the result.
beforeAll(async () => {
  mounted = await mountIsland({
    build: buildIslands,
    root: APP_ROOT,
    file: ISLAND,
    props: { label: 'Open' },
    // What the server rendered inside the island's wrapper. \`mount\` replaces it.
    shell: '<span>Open</span>',
  });
}, 60_000);

// The fake \`document\` is process-global: left installed it reaches every LATER FILE in the run.
//
// \`?.\` on a binding the type says is always set: TypeScript's definite-assignment analysis does not
// cross the \`beforeAll\` closure, so a setup that REJECTED leaves this undefined at run time — and
// bun runs \`afterAll\` regardless. Unguarded, the build failure is followed by a \`TypeError:
// undefined is not an object\` that says nothing, and that second line is the one a tail reads.
// Nothing is skipped by the guard: \`mountIsland\` restores the process itself when a mount throws.
afterAll(() => {
  mounted?.[Symbol.dispose]();
});

describe('the ${name} island', () => {
  test('mount replaces the server shell', () => {
    expect(mounted.find('span')).toBeNull();
    // Solid compiles to real DOM calls; a chunk that fell back to the classic React factory names
    // a global that is not in it, and \`Bun.build\` answers \`success: true\` over that all the same.
    expect(mounted.code).not.toMatch(/\\bReact\\b/);
  });

  test('a click reaches the DOM through the signal', () => {
    expect(mounted.text('[data-role="count"]')).toBe('0');
    // \`false\` means no handler ran — an island whose onClick never reached the DOM looks identical
    // to a selector typo otherwise.
    expect(mounted.fire('button', 'click')).toBe(true);
    expect(mounted.text('[data-role="count"]')).toBe('1');
  });
});
`;

/**
 * The states file beside the entry, and it ships WITH the island rather than after it: `x verify`'s
 * `boundaries` step refuses an island that declares none (`guards/island-without-states.ts`), so a
 * generator that wrote only the component would scaffold a file that fails the app's own gate on
 * the next command. The second state is the point of the whole mechanism — a label a translation
 * is three times as long in is a state nobody can reach by clicking in the locale they develop in.
 */
const islandStates = (name: string, dir: string): string => {
  const Name = pascal(name);
  return `// The states \`${name}\` can be photographed in. \`x shot --island ${name} --json\` takes one
// picture per state per theme into \`.x/shot/island/${name}/\`, and the states worth declaring are
// the ones a running app will not produce on request.
//
// PURE DATA. No JSX, no \`solid-js\`, and the one import below is \`import type\`, which
// \`verbatimModuleSyntax\` erases entirely — the command that takes the pictures has to know the
// complete expected list before a browser exists. \`X_TEST_ISLAND_STATES_NOT_PURE\` is the refusal.
//
// The labels are literals here and that is not a \`t()\` violation: an island's props cross the seam
// as JSON inside the document, so the SERVER translates and the browser is handed text.

import { defineIslandStates } from '@ultimat3/testing';
import type { ${Name}Props } from './${name}.island';

export const ${camel(name)}States = defineIslandStates({
  island: '${dir}/${name}.island.tsx',
  states: [
    {
      id: 'idle',
      title: 'the first paint, before anything has been clicked',
      props: { label: 'Open' } satisfies ${Name}Props,
    },
    {
      id: 'long-label',
      title: 'the label a translation is three times as long in',
      note: 'you cannot reach this by clicking: it needs a locale whose word for this is long, and the one this was written in is not it',
      props: { label: 'Abrechnungseinstellungen anzeigen' } satisfies ${Name}Props,
    },
  ],
});
`;
};

export function islandFiles(rawName: string, options: IslandOptions): readonly GeneratedFile[] {
  const name = kebab(rawName);
  const dir = options.dir.replace(/\/+$/, '');
  return [
    { path: `${dir}/${name}.island.tsx`, contents: islandSource(name) },
    { path: `${dir}/${name}.module.scss`, contents: islandStyle() },
    { path: `${dir}/${name}.island.states.ts`, contents: islandStates(name, dir) },
    { path: `${dir}/${name}.island.test.ts`, contents: islandTest(name, dir) },
  ];
}
