/**
 * The states the header's like count can be photographed in. It reads one record out of the page
 * store and renders a count; with no store behind it the count is the one the SERVER sent, which
 * is the first paint every reader sees.
 *
 * PURE DATA. No JSX, no `solid-js`, and the one import below is `import type`, which
 * `verbatimModuleSyntax` erases entirely. `X_TEST_ISLAND_STATES_NOT_PURE` is the refusal.
 *
 * The strings are literals and that is not a `t()` violation: an island's props cross the seam as
 * JSON in the document, so the SERVER translates and the browser is handed text.
 */

import { defineIslandStates } from '@ultimat3/testing';
import type { LikesBadgeProps } from './likes-badge.island';

const BASE = {
  postId: '00000000-0000-4000-8000-0000000000c1',
  likeCount: 2,
  likes: { locale: 'en', forms: { one: '{count} like', other: '{count} likes' } },
} satisfies LikesBadgeProps;

export const likesBadgeStates = defineIslandStates({
  island: 'apps/web/app/posts/[id]/likes-badge.island.tsx',
  viewport: { width: 320, height: 80 },
  states: [
    { id: 'plural', title: 'a count the plural rules phrase as "other"', props: BASE },
    {
      id: 'singular',
      title: 'one like: the "one" form, picked by the locale’s own rules',
      note: 'you cannot choose this by clicking: it is whatever count the post holds',
      props: { ...BASE, likeCount: 1 } satisfies LikesBadgeProps,
    },
  ],
});
