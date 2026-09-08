/**
 * The states the feed can be photographed in, and the same gap `like.island.states.ts` records:
 *
 * **No picture comes out of this file yet.** `mount` builds a `LiveClient` and calls `connect()`,
 * which dials `socketFor(props.syncUrl)`; the shot harness replaces `window.WebSocket` with a
 * function that THROWS (`packages/cli/src/island-harness-script.ts:70`), so `mount` rejects and
 * `photographFault` refuses the shutter with "mounted and its mount() REJECTED". The seal stubs
 * `fetch` and has no equivalent for a socket; nothing in this app closes that.
 *
 * The three states below are what a props object can reach once it does — and they are exactly the
 * three the component's own `Show` ladder distinguishes, which is why the list is complete rather
 * than a sample. `live-with-rows` is not among them: rows arrive over the socket, never as props.
 *
 * PURE DATA. No JSX, no `solid-js`, and the one import below is `import type`, which
 * `verbatimModuleSyntax` erases entirely — the command that takes the pictures has to know the
 * complete expected list before a browser exists. `X_TEST_ISLAND_STATES_NOT_PURE` is the refusal.
 *
 * The label strings are literals here and that is not a `t()` violation: an island's props cross the
 * seam as JSON in the document, so the SERVER translates and the browser is handed text.
 */

import { defineIslandStates } from '@ultimat3/testing';
import type { FeedIslandProps } from './feed.island';

const BASE = {
  syncUrl: 'ws://localhost:3001',
  buildId: 'shot',
  actorId: '00000000-0000-4000-8000-0000000000bb',
  orgId: '00000000-0000-4000-8000-0000000000aa',
  labels: {
    loading: 'Loading the feed…',
    empty: 'Nothing published yet.',
    offline: 'You are offline — this is the copy on this device.',
  },
} satisfies FeedIslandProps;

export const feedStates = defineIslandStates({
  island: 'apps/web/app/feed/feed.island.tsx',
  viewport: { width: 720, height: 480 },
  states: [
    {
      id: 'loading',
      title: 'the subscription is in flight and the node has answered nothing',
      note: 'the state every reader sees first and nobody can hold still: it lasts exactly as long as one round trip to the sync node',
      props: BASE,
    },
    {
      id: 'long-labels',
      title: 'the same three notices in a locale whose words for them are much longer',
      note: 'you cannot reach this by clicking: it needs a locale this app was not written in',
      props: {
        ...BASE,
        labels: {
          loading: 'Se încarcă fluxul de postări al organizației…',
          empty: 'Nu a fost publicată încă nicio postare în această organizație.',
          offline:
            'Sunteți offline — acesta este exemplarul aflat pe acest dispozitiv, nu cel de pe server.',
        },
      },
    },
  ],
});
