/**
 * The states the like control can be photographed in — and, first, the honest statement of what
 * `x shot --island like --json` does today, because a declaration that hides its own gap is the
 * defect this app's `guards/island-without-states.ts` exists to end.
 *
 * `mount` opens nothing itself: the like control's hooks reach the page's one socket, which the
 * shot harness's sealed network refuses, so the control renders with the count the SERVER sent and
 * holds it — which is exactly the first paint a reader sees. The optimistic and rolled-back states
 * need a click and a server, which a props object cannot supply; `like.island.test.ts` and the
 * app's e2e suite prove those through the real chunk.
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
  labels: {
    like: 'Like',
    likes: { locale: 'en', forms: { one: '{count} like', other: '{count} likes' } },
    queued: 'Queued — this will be sent when you are back online.',
    update: 'A new version is ready.',
    reload: 'Reload',
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
          likes: {
            locale: 'ro',
            forms: {
              one: '{count} persoană apreciază',
              few: '{count} persoane apreciază',
              other: '{count} de persoane apreciază',
            },
          },
          queued: 'În așteptare — se va trimite când reveniți online.',
          update: 'O versiune nouă este disponibilă.',
          reload: 'Reîncarcă',
        },
      } satisfies LikeIslandProps,
    },
  ],
});
