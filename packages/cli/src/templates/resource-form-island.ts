// The slice's client entry: `x g resource <name>` emits its form as an ISLAND, because that is the
// one shape the framework compiles for a browser. A plain `.tsx` with a signal and an `onSubmit`
// is not a smaller version of this — the island glob never discovers it, and a server render drops
// every `on*` prop (`packages/render/src/html.ts`) and reads each signal exactly once.

import { upToAppRoot } from './island';
import type { GeneratedFile, NameSet } from './naming';

const formIslandSource = (
  feature: NameSet,
): string => `// ${feature.pascal}Form: the only module of the ${feature.kebab} slice a browser downloads.
//
// The page names this file by SPECIFIER, never by import:
//   const ${feature.pascal}Form = island({
//     src: './${feature.kebab}-form.island.tsx',
//     props: ['endpoint', 'locale', 'labels'],
//   });
// A string has no import edge, so the page's bundle graph stays the page's (axiom 6).

import { Button, Form, Input, setSolidRuntime, UiProvider } from '@ultimat3/ui';
import type { JSX } from 'solid-js';
import * as solidRuntime from 'solid-js';
import { createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import styles from './ui.module.scss';

/** Every string this module renders, and the path it posts to. An island's props cross the seam as
 *  JSON inside the document, so \`t()\`'s catalog cannot travel — the server translates. */
export interface ${feature.pascal}FormProps {
  /** \`derivePath('create${feature.pascal}').path\`, minted on the server: one namer for the route. */
  readonly endpoint: string;
  /** The request's own locale. A browser has no ambient one the server ever agreed to. */
  readonly locale: string;
  readonly labels: {
    readonly title: string;
    readonly submit: string;
    readonly saved: string;
    readonly retry: string;
  };
}

type SaveState = 'idle' | 'saved' | 'failed';

/**
 * Presentation only: the action this submits to owns validation server-side, so the form never
 * re-implements the invariant — a blank title fails at the boundary, not in the DOM.
 *
 * A plain \`fetch\` to the path the server minted, not the typed client: \`rpc()\` pulls
 * \`@ultimat3/action\` into the chunk, which is larger than everything else here put together. The
 * naming rule is still the framework's; only the transport is second.
 */
function ${feature.pascal}FormBody(props: ${feature.pascal}FormProps): JSX.Element {
  const [title, setTitle] = createSignal('');
  const [state, setState] = createSignal<SaveState>('idle');

  const send = async (): Promise<void> => {
    const response = await fetch(props.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: title() }),
    });
    setState(response.ok ? 'saved' : 'failed');
  };

  const status = (): string => {
    if (state() === 'saved') return props.labels.saved;
    return state() === 'failed' ? props.labels.retry : '';
  };

  return (
    <Form
      class={styles.item}
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      <Input
        aria-label={props.labels.title}
        value={title()}
        onInput={(event) => setTitle(event.currentTarget.value)}
      />
      <Button type="submit">{props.labels.submit}</Button>
      <p data-role="status" role="status" aria-live="polite">
        {status()}
      </p>
    </Form>
  );
}

/**
 * The one export the hydration runtime calls — \`import(entry).then((m) => m.mount(el, props))\`.
 *
 * \`setSolidRuntime\` comes FIRST and it is not optional: \`@ultimat3/ui\` imports *types* from
 * solid-js and never a runtime, so the reactive graph a component reaches is the one an entry
 * registers. Delete the line and the first \`<UiProvider>\` render throws X_UI_RUNTIME_MISSING —
 * loud on purpose, because a DOM render that lost its runtime is a theme toggle that does nothing.
 *
 * The shell is cleared first: Solid's \`render\` APPENDS when the container already has children,
 * so without it the server's markup stays on screen above a second, live copy of the same thing.
 */
export function mount(el: HTMLElement, props: ${feature.pascal}FormProps): void {
  setSolidRuntime(solidRuntime);
  el.textContent = '';
  render(
    () => (
      <UiProvider locale={props.locale}>
        <${feature.pascal}FormBody {...props} />
      </UiProvider>
    ),
    el,
  );
}
`;

const formIslandTest = (
  feature: NameSet,
  dir: string,
): string => `// The form the browser actually runs. \`mountIsland\` builds this entry with the same
// \`buildIslands\` that \`x build\` and \`x dev\` use, imports the emitted chunk the way the hydration
// runtime does, and drives \`mount\` against a DOM small enough to read.
//
// It is the test that keeps this file a CLIENT entry. A generated form that only typechecks is
// what shipped before: server-rendered, every \`on*\` prop dropped, every signal read once.

import { join } from 'node:path';
import { buildIslands } from '@ultimat3/cli';
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  type FakeElement,
  type MountedIsland,
  mountIsland,
  test,
} from '@ultimat3/testing';

const APP_ROOT = join(import.meta.dir, ${upToAppRoot(dir)});
const ISLAND = '${dir}/${feature.kebab}-form.island.tsx';
const ENDPOINT = '/api/${feature.kebab}/create-${feature.kebab}';

const LABELS = { title: 'Title', submit: 'Save', saved: 'Saved', retry: 'Try again' };

const calls: { url: string; body: Record<string, unknown> }[] = [];

let mounted: MountedIsland;

// The build is a Babel pass plus a browser bundle — seconds, not milliseconds. It lives in
// \`beforeAll\` with its own timeout because \`test\` takes no third argument: fixtures are resolved
// per case, so the slow work goes where it can be given one and every case shares the result.
beforeAll(async () => {
  mounted = await mountIsland({
    build: buildIslands,
    root: APP_ROOT,
    file: ISLAND,
    props: { endpoint: ENDPOINT, locale: 'en', labels: LABELS },
    // What the server rendered inside the island's wrapper. \`mount\` replaces it.
    shell: '<p>Loading</p>',
    globals: {
      fetch: (url: string, init: { body: string }): Promise<{ ok: boolean }> => {
        calls.push({ url, body: JSON.parse(init.body) as Record<string, unknown> });
        return Promise.resolve({ ok: true });
      },
    },
  });
}, 60_000);

// The fake \`document\` is process-global: left installed it reaches every LATER FILE in the run.
afterAll(() => {
  mounted[Symbol.dispose]();
});

/**
 * One mount, driven as a session: the cases below run in order against the same island, because
 * building the real chunk costs seconds and repeating it per case would pay them for state each
 * case sets up anyway. What each one asserts is independent.
 */
describe('the ${feature.kebab} form island', () => {
  test('mount replaces the server shell with the editor', () => {
    expect(mounted.find('p')?.getAttribute('data-role')).toBe('status');
    // Solid compiles to real DOM calls; a chunk that fell back to the classic React factory names
    // a global that is not in it, and \`Bun.build\` answers \`success: true\` over that all the same.
    expect(mounted.code).not.toMatch(/\\bReact\\b/);
  });

  test('the field tracks, and submit posts what was typed', async () => {
    const field: FakeElement | null = mounted.find('input');
    expect(field).not.toBeNull();
    if (field !== null) field.value = 'First ${feature.camel}';
    // \`false\` means no handler ran — an island whose onInput never reached the DOM looks
    // identical to a selector typo otherwise.
    expect(mounted.fire(field, 'input')).toBe(true);
    expect(mounted.fire('form', 'submit', { preventDefault: () => {} })).toBe(true);
    await Promise.resolve();

    expect(calls).toEqual([{ url: ENDPOINT, body: { title: 'First ${feature.camel}' } }]);
  });

  test('the status line answers the response', () => {
    // The signal reached the DOM: an eager JSX factory renders '' here and never runs again.
    expect(mounted.text('[data-role="status"]')).toBe(LABELS.saved);
  });
});
`;

/** The slice's form, as the one client shape: `<dir>/<feature>-form.island.tsx` plus its test. */
export function formIslandFiles(feature: NameSet, dir: string): readonly GeneratedFile[] {
  return [
    {
      path: `${dir}/${feature.kebab}-form.island.tsx`,
      contents: formIslandSource(feature),
    },
    {
      path: `${dir}/${feature.kebab}-form.island.test.ts`,
      contents: formIslandTest(feature, dir),
    },
  ];
}
