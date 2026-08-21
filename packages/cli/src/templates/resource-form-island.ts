// The slice's client entry: `x g resource <name>` emits its form as an ISLAND, because that is the
// one shape the framework compiles for a browser. A plain `.tsx` with a signal and an `onSubmit`
// is not a smaller version of this — the island glob never discovers it, and a server render drops
// every `on*` prop (`packages/render/src/html.ts`) and reads each signal exactly once.

// Bun ships no path API, and the one arithmetic this file does is a specifier: the island's path
// seen from the page's directory, which `island-bundle.ts` resolves the same way at build time.
import { posix } from 'node:path';
import { upToAppRoot } from './island';
import type { GeneratedFile, NameSet } from './naming';

/**
 * What the PAGE has to write, which is not what the island's own directory would suggest.
 *
 * `island({ src })` resolves against the route file, and `x g resource widget` writes its page at
 * `apps/web/app/widgets/` while the island lands in `apps/web/app/widget/` — so the `'./…'` this
 * file used to print resolved to `apps/web/app/widgets/widget-form.island.tsx`, a path the build
 * never bundles, and an author following the comment got `X_ISLAND_INVALID`. Derived from the two
 * directories rather than written down, so it cannot disagree with where the files actually go.
 */
export const formIslandSpecifier = (feature: NameSet, dir: string, pageDir: string): string => {
  const relative = posix.join(posix.relative(pageDir, dir), `${feature.kebab}-form.island.tsx`);
  return relative.startsWith('.') ? relative : `./${relative}`;
};

const formIslandSource = (
  feature: NameSet,
  specifier: string,
): string => `// ${feature.pascal}Form: the only module of the ${feature.kebab} slice a browser downloads.
//
// The page names this file by SPECIFIER, never by import — and the specifier is resolved against
// the PAGE, which is one directory across from this one:
//   const ${feature.pascal}Form = island({
//     src: '${specifier}',
//     props: ['endpoint', 'locale', 'labels'],
//   });
//   <${feature.pascal}Form endpoint={derivePath('create${feature.pascal}').path} locale={locale} labels={labels} />
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

  // A rejected \`fetch\` — offline, DNS, an aborted request — is the same OUTCOME as a refused one,
  // and it is the one \`retry\` exists for. Without the catch, \`setState\` is never reached: the
  // status line stays empty, and the rejection escapes the \`void send()\` below as an unhandled one.
  const send = async (): Promise<void> => {
    try {
      const response = await fetch(props.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: title() }),
      });
      setState(response.ok ? 'saved' : 'failed');
    } catch {
      setState('failed');
    }
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

/** One stub, both outcomes: the mount costs seconds, so the network's answer is a switch. */
let networkFails = false;

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
        // What a browser rejects with when there is no network. Not a response: \`response.ok\`
        // is never read on this path, which is exactly why the form has to catch it.
        return networkFails
          ? Promise.reject(new TypeError('Failed to fetch'))
          : Promise.resolve({ ok: true });
      },
    },
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

  test('a request that never got a response still reaches retry', async () => {
    // The outcome \`retry\` is FOR. A \`fetch\` that rejects reaches no \`response.ok\`, so without
    // the catch in \`send\` the status line stays on its last value and the rejection escapes.
    networkFails = true;
    expect(mounted.fire('form', 'submit', { preventDefault: () => {} })).toBe(true);
    await Promise.resolve();
    await Promise.resolve();

    expect(mounted.text('[data-role="status"]')).toBe(LABELS.retry);
  });
});
`;

/**
 * The slice's form, as the one client shape: `<dir>/<feature>-form.island.tsx` plus its test.
 *
 * `pageDir` is the directory of the page that declares it — the caller's, because only the caller
 * runs both generators and knows where the other one put its file.
 */
export function formIslandFiles(
  feature: NameSet,
  dir: string,
  pageDir: string,
): readonly GeneratedFile[] {
  return [
    {
      path: `${dir}/${feature.kebab}-form.island.tsx`,
      contents: formIslandSource(feature, formIslandSpecifier(feature, dir, pageDir)),
    },
    {
      path: `${dir}/${feature.kebab}-form.island.test.ts`,
      contents: formIslandTest(feature, dir),
    },
  ];
}
