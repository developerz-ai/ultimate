/**
 * The states the like control can be photographed in — and, first, the honest statement of what
 * `x shot --island like --json` does today, because a declaration that hides its own gap is the
 * defect this app's `guards/island-without-states.ts` exists to end.
 *
 * **No picture comes out of this file yet.** `mount` builds a `LiveClient` and calls `connect()`,
 * which dials `socketFor(props.syncUrl)`; the shot harness replaces `window.WebSocket` with a
 * function that THROWS (`packages/cli/src/island-harness-script.ts:70`, the sealed network — an
 * unstubbed request must fail a run rather than be answered), `LiveClient.connect` re-throws to its
 * caller by design, and `mount` therefore rejects. `photographFault` reports "mounted and its
 * mount() REJECTED" and refuses the shutter. Nothing in the app can fix that: the seal has a stub
 * table for `fetch` and none for a socket, and giving `mount` a socket it can survive losing is a
 * production change made for a screenshot.
 *
 * **And the two states the optimistic path is actually about are not addressable by props either.**
 * `optimistic-pending` needs a CLICK and `rolled-back` needs a click plus a refusing server, and a
 * state is a props object — the harness never clicks. `/settings` reaches its two through
 * `SettingsProps.status`, a prop that exists for that and only that; the equivalent here would be a
 * `likedByMe` prop, and the page could only ever pass `false` for it, because `postById` does not
 * answer whether this member has already liked the row. A prop with one possible value from the one
 * caller is not a state, it is a decoration. `apps/web/app/posts/[id]/like.island.test.ts` is where
 * both states are proved instead, through the real chunk and the real protocol.
 *
 * So what is declared below is what a props object can really reach, and it is declared so that the
 * expected list exists the day the harness gains a socket stub.
 *
 * PURE DATA. No JSX, no `solid-js`, and the one import below is `import type`, which
 * `verbatimModuleSyntax` erases entirely — the command that takes the pictures has to know the
 * complete expected list before a browser exists. `X_TEST_ISLAND_STATES_NOT_PURE` is the refusal.
 *
 * The label strings are literals here and that is not a `t()` violation: an island's props cross the
 * seam as JSON in the document, so the SERVER translates and the browser is handed text.
 */

import { defineIslandStates } from '@ultimat3/testing';
import type { LikeIslandProps } from './like.island';

const BASE = {
  postId: '00000000-0000-4000-8000-0000000000c1',
  orgId: '00000000-0000-4000-8000-0000000000aa',
  likeCount: 2,
  syncUrl: 'ws://localhost:3001',
  buildId: 'shot',
  actorId: '00000000-0000-4000-8000-0000000000bb',
  labels: {
    like: 'Like',
    count: '2 likes',
    countWithMine: '3 likes',
    queued: 'Queued — this will be sent when you are back online.',
  },
} satisfies LikeIslandProps;

export const likeStates = defineIslandStates({
  island: 'apps/web/app/posts/[id]/like.island.tsx',
  // One row of controls. The count sits beside the button, so the interesting failure is
  // horizontal — a label that wraps under it is the thing a picture would show.
  viewport: { width: 480, height: 160 },
  states: [
    {
      id: 'idle',
      title: 'the first paint: the count the server rendered, and a button that now works',
      props: BASE,
    },
    {
      id: 'long-labels',
      title: 'the same control in a locale whose words for it are three times as long',
      note: 'you cannot reach this by clicking: it needs a locale this app was not written in, and the row is one flex line — this is where the count wraps under the button or does not',
      props: {
        ...BASE,
        labels: {
          like: 'Îmi place această postare',
          count: '2 persoane apreciază',
          countWithMine: '3 persoane apreciază',
          queued: 'În așteptare — se va trimite când reveniți online.',
        },
      } satisfies LikeIslandProps,
    },
  ],
});
