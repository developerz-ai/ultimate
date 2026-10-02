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
//     props: ['endpoint', 'locale', 'currency', 'labels'],
//   });
//   <${feature.pascal}Form endpoint={derivePath('create${feature.pascal}').path} locale={locale}
//     currency="USD" labels={labels} />
// A string has no import edge, so the page's bundle graph stays the page's (axiom 6).

import { clientTransport } from '@ultimat3/core';
import { fromDecimal } from '@ultimat3/money';
import { Button, Form, Input, setSolidRuntime, UiProvider } from '@ultimat3/ui';
import type { JSX } from 'solid-js';
import {
  createContext,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  useContext,
} from 'solid-js';
import { render } from 'solid-js/web';
import styles from './ui.module.scss';

/** Every string this module renders, and the path it posts to. An island's props cross the seam as
 *  JSON inside the document, so \`t()\`'s catalog cannot travel — the server translates. */
export interface ${feature.pascal}FormProps {
  /** \`derivePath('create${feature.pascal}').path\`, minted on the server: one namer for the route. */
  readonly endpoint: string;
  /** The request's own locale. A browser has no ambient one the server ever agreed to. */
  readonly locale: string;
  /** The ISO code the price is entered in. The amount is typed as a decimal and sent as minor units. */
  readonly currency: string;
  readonly labels: {
    readonly title: string;
    readonly price: string;
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
 * \`clientTransport\` — the framework's one browser HTTP function — to the path the server minted.
 * Never a raw \`fetch\`: the transport is what decodes a refusal into its code, fences a sign-out,
 * and hands any entity rows the answer carries to the page's store.
 */
function ${feature.pascal}FormBody(props: ${feature.pascal}FormProps): JSX.Element {
  const [title, setTitle] = createSignal('');
  const [amount, setAmount] = createSignal('');
  const [state, setState] = createSignal<SaveState>('idle');

  // A refusal and a request that never got a response both REJECT here — the transport turns a
  // non-2xx into its code and an offline \`fetch\` into X_CLIENT_TRANSPORT_FAILED — and both are the
  // outcome \`retry\` exists for. Without the catch the rejection escapes \`void send()\` unhandled.
  // The body is the create action's input: the entity's own columns, the price as integer minor
  // units. \`fromDecimal\` reads the typed digits as a string, never a float, and refuses what is not
  // a number — the same \`retry\` state, because the server would refuse it too.
  const send = async (): Promise<void> => {
    try {
      const price = fromDecimal(amount(), props.currency);
      await clientTransport({
        method: 'POST',
        url: props.endpoint,
        body: { title: title(), price },
      });
      setState('saved');
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
      <Input
        aria-label={props.labels.price}
        inputmode="decimal"
        value={amount()}
        onInput={(event) => setAmount(event.currentTarget.value)}
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
 * Six NAMED imports, never \`import * as solidRuntime\`: a namespace object handed to a function
 * keeps every export of solid-js alive, and the bundler cannot shake what it cannot see unused —
 * measured at 14.8 kB minified per island chunk (5.6 kB gzipped) for the namespace form.
 *
 * The shell is cleared first: Solid's \`render\` APPENDS when the container already has children,
 * so without it the server's markup stays on screen above a second, live copy of the same thing.
 */
export function mount(el: HTMLElement, props: ${feature.pascal}FormProps): void {
  setSolidRuntime({ createContext, useContext, createSignal, createMemo, createEffect, onCleanup });
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
): string => `// The form the browser actually runs, in every state its manifest declares: built once for this
// file with the same \`buildIslands\` that \`x build\` and \`x dev\` use, imported the way the
// hydration runtime imports it, and driven against a DOM small enough to read.
//
// It is the test that keeps this file a CLIENT entry. A generated form that only typechecks is
// what shipped before: server-rendered, every \`on*\` prop dropped, every signal read once.

import { join } from 'node:path';
import { buildIslands } from '@ultimat3/cli';
import {
  describeIslandState,
  expect,
  type FakeElement,
  type MountedIsland,
  test,
} from '@ultimat3/testing';
import { ${feature.camel}FormStates } from './${feature.kebab}-form.island.states';

const calls: { url: string; body: Record<string, unknown> }[] = [];

/** One stub, both outcomes: a block shares its mount, so the network's answer is a switch. */
let networkFails = false;

// One block per declared state: \`describeIslandState\` mounts it before the block's first test
// and disposes it after the last. The props are the manifest's own — what
// \`x shot --island ${feature.kebab}-form\` photographs — so the picture and the test are of one
// component.
const island = {
  build: buildIslands,
  root: join(import.meta.dir, ${upToAppRoot(dir)}),
  // What the server rendered inside the island's wrapper. \`mount\` replaces it.
  shell: '<p>Loading</p>',
  globals: {
    // The form sends through \`clientTransport\`, which calls \`globalThis.fetch\` — this stub.
    fetch: (url: string, init: { body: string }): Promise<Response> => {
      calls.push({ url, body: JSON.parse(init.body) as Record<string, unknown> });
      // What a browser rejects with when there is no network. Not a response, which is exactly
      // why the form has to catch it.
      return networkFails
        ? Promise.reject(new TypeError('Failed to fetch'))
        : Promise.resolve(Response.json({ id: 'created' }));
    },
  },
};

/**
 * Until the status line changes, a bounded number of macrotasks: the send is several awaits deep
 * inside \`clientTransport\`, so counting microtasks would pin the transport, not the form.
 */
async function statusSettled(mounted: MountedIsland): Promise<void> {
  const before = mounted.text('[data-role="status"]');
  for (let tick = 0; tick < 50; tick += 1) {
    if (mounted.text('[data-role="status"]') !== before) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

// Each case sets the network's answer itself and asserts on what its own submit produced, so
// none depends on the one before it.
describeIslandState(${feature.camel}FormStates, 'idle', island, (mounted) => {
  test('mount replaces the server shell with the editor', () => {
    expect(mounted().find('p')?.getAttribute('data-role')).toBe('status');
    expect(mounted().text('button')).toBe('Save');
    // Solid compiles to real DOM calls; a chunk that fell back to the classic React factory names
    // a global that is not in it, and \`Bun.build\` answers \`success: true\` over that all the same.
    expect(mounted().code).not.toMatch(/\\bReact\\b/);
  });

  test('the fields track, submit posts the create input, and the status answers', async () => {
    networkFails = false;
    const title: FakeElement | null = mounted().find('input[aria-label="Title"]');
    const price: FakeElement | null = mounted().find('input[aria-label="Price"]');
    expect(title).not.toBeNull();
    expect(price).not.toBeNull();
    if (title !== null) title.value = 'First ${feature.camel}';
    if (price !== null) price.value = '12.50';
    // \`false\` means no handler ran — an island whose onInput never reached the DOM looks
    // identical to a selector typo otherwise.
    expect(mounted().fire(title, 'input')).toBe(true);
    expect(mounted().fire(price, 'input')).toBe(true);
    expect(mounted().fire('form', 'submit', { preventDefault: () => {} })).toBe(true);
    await statusSettled(mounted());

    const body = {
      title: 'First ${feature.camel}',
      price: { minor: 1250, currency: 'USD' },
    };
    // The endpoint is the state's own: the form posts where the server told it to.
    expect(calls.at(-1)).toEqual({ url: '/api/${feature.pluralKebab}/create', body });
    // The signal reached the DOM: an eager JSX factory renders '' here and never runs again.
    expect(mounted().text('[data-role="status"]')).toBe('Saved');
  });

  test('a request that never got a response still reaches retry', async () => {
    // The outcome \`retry\` is FOR. A \`fetch\` that rejects produces no answer, so without the
    // catch in \`send\` the status line stays on its last value and the rejection escapes.
    networkFails = true;
    expect(mounted().fire('form', 'submit', { preventDefault: () => {} })).toBe(true);
    await statusSettled(mounted());

    expect(mounted().text('[data-role="status"]')).toBe('That did not save. Try again.');
  });
});

describeIslandState(${feature.camel}FormStates, 'long-labels', island, (mounted) => {
  test('every label is the state’s own, in the locale it names', () => {
    // Whether they FIT is a picture's question — \`x shot --island ${feature.kebab}-form\`. What a
    // test can say is that the island was handed this state's text, and none of the idle one's.
    expect(mounted().find('input[aria-label="Bezeichnung des Beitrags"]')).not.toBeNull();
    expect(mounted().find('input[aria-label="Title"]')).toBeNull();
    expect(mounted().text('button')).toBe('Änderungen speichern');
    expect(mounted().documentElement.getAttribute('lang')).toBe('de');
  });
});
`;

/**
 * The states file beside the entry, and it ships WITH the island rather than after it: `x verify`'s
 * `boundaries` step refuses an island that declares none (`guards/island-without-states.ts`), so a
 * generator that wrote only the component would scaffold a file that fails the app's own gate on
 * the next command.
 */
const formIslandStates = (
  feature: NameSet,
  dir: string,
): string => `// The states the ${feature.kebab} form can be photographed in. \`x shot --island ${feature.kebab}-form --json\`
// takes one picture per state per theme into \`.x/shot/island/${feature.kebab}-form/\`, and the states
// worth declaring are the ones a running app will not produce on request.
//
// PURE DATA. No JSX, no \`solid-js\`, and the one import below is \`import type\`, which
// \`verbatimModuleSyntax\` erases entirely — the command that takes the pictures has to know the
// complete expected list before a browser exists. \`X_TEST_ISLAND_STATES_NOT_PURE\` is the refusal.
//
// The labels are literals here and that is not a \`t()\` violation: an island's props cross the seam
// as JSON inside the document, so the SERVER translates and the browser is handed text. These are
// the text the server would have handed it.

import { defineIslandStates } from '@ultimat3/testing';
import type { ${feature.pascal}FormProps } from './${feature.kebab}-form.island';

/** What a working render hands the form — the baseline the state below departs from. */
const BASE = {
  endpoint: '/api/${feature.pluralKebab}/create',
  locale: 'en',
  currency: 'USD',
  labels: {
    title: 'Title',
    price: 'Price',
    submit: 'Save',
    saved: 'Saved',
    retry: 'That did not save. Try again.',
  },
} satisfies ${feature.pascal}FormProps;

export const ${feature.camel}FormStates = defineIslandStates({
  island: '${dir}/${feature.kebab}-form.island.tsx',
  states: [
    {
      id: 'idle',
      title: 'the first paint, before anything has been typed',
      props: BASE satisfies ${feature.pascal}FormProps,
    },
    {
      id: 'long-labels',
      title: 'the same form in a locale whose words are three times as long',
      note: 'you cannot reach this by clicking: it needs a translation, and the locale this was written in is the one that fits',
      props: {
        ...BASE,
        locale: 'de',
        labels: {
          title: 'Bezeichnung des Beitrags',
          price: 'Preis',
          submit: 'Änderungen speichern',
          saved: 'Änderungen gespeichert',
          retry: 'Das konnte nicht gespeichert werden. Bitte erneut versuchen.',
        },
      } satisfies ${feature.pascal}FormProps,
    },
  ],
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
      path: `${dir}/${feature.kebab}-form.island.states.ts`,
      contents: formIslandStates(feature, dir),
    },
    {
      path: `${dir}/${feature.kebab}-form.island.test.ts`,
      contents: formIslandTest(feature, dir),
    },
  ];
}
