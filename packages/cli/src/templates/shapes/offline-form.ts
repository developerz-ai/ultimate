// `--shape offline`'s post form: the default form, written through realtime's ONE outbox instead of
// a bare transport call. Online it posts at once; offline — or when the request never answered —
// the write lands in IndexedDB under its idempotency key and is replayed when the network returns.

import type { GeneratedFile } from '../naming';

const DIR = 'apps/web/app/post';

const island =
  (): string => `// PostForm: the only module of the post slice a browser downloads — and the write that survives
// a lost network. The page names this file by SPECIFIER, never by import:
//   const PostForm = island({
//     src: '../post/post-form.island.tsx',
//     props: ['locale', 'currency', 'labels'],
//   });
// A string has no import edge, so the page's bundle graph stays the page's (axiom 6).
//
// \`useMutation\` from \`@ultimat3/realtime\` is the one way a page writes: online it POSTs
// \`createPost\` under an idempotency key; offline, or when a POST never got an answer, the write
// goes to the page's outbox (IndexedDB, per signed-in member) and is replayed IN ORDER, under the
// same key, when the browser is back online or the service worker wakes it. \`createPost\` declares
// \`idempotent: true\`, so a replay of a write that did land answers the first result, never a
// second row. No queue, retry loop or \`navigator.onLine\` check lives here: the outbox owns them.

import { fromDecimal } from '@ultimat3/money';
import { type MutatorLike, useMutation, useOutbox } from '@ultimat3/realtime';
import { mountOver } from '@ultimat3/render/client';
import { Button, Form, Input, setSolidRuntime, UiProvider } from '@ultimat3/ui';
import type { JSX } from 'solid-js';
import {
  createContext,
  createEffect,
  createMemo,
  createRoot,
  createSignal,
  onCleanup,
  useContext,
} from 'solid-js';
import { render } from 'solid-js/web';
import type { Api } from '../../api';
import styles from './ui.module.scss';

/** Every string this module renders. An island's props cross the seam as JSON inside the
 *  document, so \`t()\`'s catalog cannot travel — the server translates. */
export interface PostFormProps {
  /** The request's own locale. A browser has no ambient one the server ever agreed to. */
  readonly locale: string;
  /** The ISO code the price is entered in. The amount is typed as a decimal and sent as minor units. */
  readonly currency: string;
  readonly labels: {
    readonly title: string;
    readonly price: string;
    readonly submit: string;
    readonly saved: string;
    /** Held on this device, sent when the network returns: information, not an error. */
    readonly queued: string;
    readonly retry: string;
  };
}

/**
 * \`createPost\` as the browser can name it. The action module cannot cross into a chunk (it reaches
 * the policy and the database client), so the NAME does — typed against \`Api\`, which is imported
 * as a type and erased, so a rename is a compile error and never a 404 at replay time.
 */
export const CREATE_POST: MutatorLike = {
  name: 'createPost' satisfies keyof Api['actions'],
};

type SaveState = 'idle' | 'sent' | 'failed';

/**
 * Presentation only: the action owns validation server-side, so the form never re-implements the
 * invariant — a blank title fails at the boundary, not in the DOM.
 */
function PostFormBody(props: PostFormProps): JSX.Element {
  const [title, setTitle] = createSignal('');
  const [amount, setAmount] = createSignal('');
  const [state, setState] = createSignal<SaveState>('idle');
  // Both release with the component: \`useMutation\`'s count and \`useOutbox\`'s subscription.
  const create = useMutation(CREATE_POST);
  const outbox = useOutbox();

  // A refusal — the server's, or \`fromDecimal\`'s for an amount that is not a number — rejects
  // here and is \`retry\`. A write the network could not take resolves: it is in the outbox now.
  const send = async (): Promise<void> => {
    try {
      const price = fromDecimal(amount(), props.currency);
      await create({ title: title(), price: { minor: price.minor, currency: price.currency } });
      setState('sent');
    } catch {
      setState('failed');
    }
  };

  // Queued wins over sent: the outbox's size is live, so the line turns to \`saved\` by itself the
  // moment the replay is acknowledged — no reload, no second submit.
  const status = (): string => {
    if (state() === 'failed') return props.labels.retry;
    if (outbox.size > 0) return props.labels.queued;
    return state() === 'sent' ? props.labels.saved : '';
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
      <p data-role="status" role="status" aria-live="polite" data-queued={outbox.size}>
        {status()}
      </p>
    </Form>
  );
}

/**
 * The one export the hydration runtime calls. \`setSolidRuntime\` comes FIRST — \`@ultimat3/ui\`
 * imports solid-js types only, so the reactive graph is the one this entry registers (else
 * X_UI_RUNTIME_MISSING). Seven NAMED imports, never \`import * as\`: a namespace keeps every export
 * of solid-js alive in the chunk. \`mountOver\` clears the server's shell and restores it if the
 * render throws; the disposer it returns is what the client router calls on navigation.
 */
export function mount(el: HTMLElement, props: PostFormProps): () => void {
  setSolidRuntime({
    createContext,
    useContext,
    createSignal,
    createMemo,
    createEffect,
    onCleanup,
    createRoot,
  });
  return mountOver(el, (root) =>
    render(
      () => (
        <UiProvider locale={props.locale}>
          <PostFormBody {...props} />
        </UiProvider>
      ),
      root,
    ),
  );
}
`;

const states =
  (): string => `// The states the post form can be photographed in. \`x shot --island post-form --json\`
// takes one picture per state per theme into \`.x/shot/island/post-form/\`.
//
// PURE DATA. No JSX, no \`solid-js\`, and the one import below is \`import type\`, which
// \`verbatimModuleSyntax\` erases (\`X_TEST_ISLAND_STATES_NOT_PURE\` is the refusal). The labels are
// literals and that is not a \`t()\` violation: they are the text the server would have handed it.

import { defineIslandStates } from '@ultimat3/testing';
import type { PostFormProps } from './post-form.island';

/** What a working render hands the form — the baseline the state below departs from. */
const BASE = {
  locale: 'en',
  currency: 'USD',
  labels: {
    title: 'Title',
    price: 'Price',
    submit: 'Save',
    saved: 'Saved',
    queued: 'Saved on this device. It will send when you are back online.',
    retry: 'That did not save. Try again.',
  },
} satisfies PostFormProps;

export const postFormStates = defineIslandStates({
  island: 'apps/web/app/post/post-form.island.tsx',
  states: [
    {
      id: 'idle',
      title: 'the first paint, before anything has been typed',
      props: BASE satisfies PostFormProps,
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
          queued: 'Auf diesem Gerät gespeichert. Wird gesendet, sobald Sie wieder online sind.',
          retry: 'Das konnte nicht gespeichert werden. Bitte erneut versuchen.',
        },
      } satisfies PostFormProps,
    },
  ],
});
`;

const islandTest =
  (): string => `// The form the browser actually runs, in every state its manifest declares: built with the same
// \`buildIslands\` that \`x build\` and \`x dev\` use — the realtime bootstrap included — imported the
// way the hydration runtime imports it, and driven against a DOM small enough to read.
//
// What it proves here, online: the write goes over HTTP as \`createPost\` under an idempotency key
// (the one a replay reuses), and a refusal reaches \`retry\`. That the SAME write survives a cut
// network, a reload and a replay is the browser's to prove: \`apps/web/app/posts/offline-write.e2e.test.ts\`.

import { join } from 'node:path';
import { buildIslands } from '@ultimat3/cli';
import { resetPageRealtime } from '@ultimat3/realtime';
import {
  describeIslandState,
  expect,
  type FakeElement,
  type MountedIsland,
  test,
} from '@ultimat3/testing';
import { postFormStates } from './post-form.island.states';

interface Call {
  readonly url: string;
  readonly key: string | null;
  readonly body: Record<string, unknown>;
}
const calls: Call[] = [];

/** What the next POST answers: the created row, or the server's refusal. */
let refuse = false;

const island = {
  build: buildIslands,
  root: join(import.meta.dir, '..', '..', '..', '..'),
  // The island's page connection outlives its DOM: reset with the block, never a raw afterAll.
  teardown: resetPageRealtime,
  // What the server rendered inside the island's wrapper. \`mount\` replaces it.
  shell: '<p>Loading</p>',
  globals: {
    fetch: (url: string, init: RequestInit): Promise<Response> => {
      calls.push({
        url,
        key: new Headers(init.headers).get('idempotency-key'),
        body: JSON.parse(String(init.body)) as Record<string, unknown>,
      });
      return Promise.resolve(
        refuse
          ? Response.json(
              { code: 'X_FORBIDDEN', cause: 'denied', fix: 'bunx x policy explain --json' },
              { status: 403, headers: { 'content-type': 'application/problem+json' } },
            )
          : Response.json({ id: 'created' }),
      );
    },
  },
};

/** Until the status line changes, a bounded number of macrotasks: the send is several awaits deep. */
async function statusSettled(mounted: MountedIsland): Promise<void> {
  const before = mounted.text('[data-role="status"]');
  for (let tick = 0; tick < 200; tick += 1) {
    if (mounted.text('[data-role="status"]') !== before) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

describeIslandState(postFormStates, 'idle', island, (mounted) => {
  test('mount replaces the server shell with the editor', () => {
    expect(mounted().find('p')?.getAttribute('data-role')).toBe('status');
    expect(mounted().text('button')).toBe('Save');
    expect(mounted().code).not.toMatch(/\\bReact\\b/);
  });

  test('submit sends createPost under an idempotency key, and the status answers', async () => {
    refuse = false;
    const title: FakeElement | null = mounted().find('input[aria-label="Title"]');
    const price: FakeElement | null = mounted().find('input[aria-label="Price"]');
    expect(title).not.toBeNull();
    expect(price).not.toBeNull();
    if (title !== null) title.value = 'First post';
    if (price !== null) price.value = '12.50';
    expect(mounted().fire(title, 'input')).toBe(true);
    expect(mounted().fire(price, 'input')).toBe(true);
    expect(mounted().fire('form', 'submit', { preventDefault: () => {} })).toBe(true);
    await statusSettled(mounted());

    const sent = calls.at(-1);
    expect(sent?.url).toContain('/api/posts/create');
    expect(sent?.body).toEqual({ title: 'First post', price: { minor: 1250, currency: 'USD' } });
    // The key IS the write's identity: a replay of it is answered, never run twice.
    expect(sent?.key).toMatch(/^createPost:/);
    expect(mounted().text('[data-role="status"]')).toBe('Saved');
  });

  test('a refusal reaches retry, and is never queued for a replay', async () => {
    refuse = true;
    expect(mounted().fire('form', 'submit', { preventDefault: () => {} })).toBe(true);
    await statusSettled(mounted());

    expect(mounted().text('[data-role="status"]')).toBe('That did not save. Try again.');
    expect(mounted().find('[data-role="status"]')?.getAttribute('data-queued')).toBe('0');
  });
});

describeIslandState(postFormStates, 'long-labels', island, (mounted) => {
  test('every label is the state’s own, in the locale it names', () => {
    expect(mounted().find('input[aria-label="Bezeichnung des Beitrags"]')).not.toBeNull();
    expect(mounted().find('input[aria-label="Title"]')).toBeNull();
    expect(mounted().text('button')).toBe('Änderungen speichern');
    expect(mounted().documentElement.getAttribute('lang')).toBe('de');
  });
});
`;

/** The island, its states and its test — each REPLACING the default form's file of the same path. */
export const offlineFormFiles = (): readonly GeneratedFile[] => [
  { path: `${DIR}/post-form.island.tsx`, contents: island() },
  { path: `${DIR}/post-form.island.states.ts`, contents: states() },
  { path: `${DIR}/post-form.island.test.ts`, contents: islandTest() },
];
