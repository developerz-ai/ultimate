/**
 * The states the posts board can be photographed in: a board with a card in every column, one
 * with nothing to schedule, and the label three times as long. A drag and a refused move need a
 * pointer and a server, which a props object cannot supply — `ui-drag.e2e.test.ts` proves those.
 *
 * PURE DATA. No JSX, no `solid-js`, and the one import below is `import type`, which
 * `verbatimModuleSyntax` erases entirely. `X_TEST_ISLAND_STATES_NOT_PURE` is the refusal.
 *
 * The label strings are literals here and that is not a `t()` violation: an island's props cross
 * the seam as JSON in the document, so the SERVER translates and the browser is handed text.
 */

import { defineIslandStates } from '@ultimat3/testing';
import type { BoardIslandProps } from './board.island';

const post = (n: number, status: 'draft' | 'scheduled' | 'published', title: string) => ({
  id: `00000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`,
  title,
  status,
});

const BASE = {
  locale: 'en',
  zone: 'Europe/Bucharest',
  posts: [
    post(1, 'draft', 'Quarterly numbers, explained'),
    post(2, 'draft', 'What we learned shipping offline likes'),
    post(3, 'scheduled', 'Release notes for 30.0'),
    post(4, 'published', 'Hello, world'),
  ],
  labels: {
    board: 'Posts by status',
    columns: { draft: 'Draft', scheduled: 'Scheduled', published: 'Published' },
  },
  action: '/api/posts/move-post-status',
  ui: {
    locale: 'en',
    catalog: {
      'ui.sort.handle': 'Move',
      'ui.sort.target': 'Move to',
    },
  },
} satisfies BoardIslandProps;

export const boardStates = defineIslandStates({
  island: 'apps/web/app/posts/board/board.island.tsx',
  // Three columns side by side; below `sm` the board is one column wide and scrolls sideways.
  viewport: { width: 960, height: 480 },
  states: [
    { id: 'idle', title: 'the first paint: every column with its posts', props: BASE },
    {
      id: 'empty',
      title: 'an org with nothing to schedule',
      note: 'columns stay, each a drop target, so the board reads as a board before a post exists',
      props: { ...BASE, posts: [] },
    },
    {
      id: 'long-labels',
      title: 'a title and a column name three times as long',
      props: {
        ...BASE,
        posts: [
          post(
            1,
            'draft',
            'A title long enough to wrap twice in a column a third of the page wide, and then some',
          ),
        ],
        labels: {
          ...BASE.labels,
          columns: {
            draft: 'Drafts waiting for review',
            scheduled: 'Scheduled for later',
            published: 'Published',
          },
        },
      },
    },
  ],
});
