/**
 * The states the summary can be photographed in. With no server behind the harness the button
 * streams nothing, so the one state is the SERVER's markup: the button, an empty summary, no status.
 * The streamed text is a browser-and-server fact, held by `e2e/summary-stream.e2e.test.ts`.
 *
 * PURE DATA. No JSX, no `solid-js`, and the one import below is `import type`, which
 * `verbatimModuleSyntax` erases entirely. `X_TEST_ISLAND_STATES_NOT_PURE` is the refusal.
 *
 * The strings are literals and that is not a `t()` violation: an island's props cross the seam as
 * JSON in the document, so the SERVER translates and the browser is handed text.
 */

import { defineIslandStates } from '@ultimat3/testing';
import type { SummaryProps } from './summary.island';

const BASE = {
  postId: '00000000-0000-4000-8000-0000000000c1',
  orgId: '00000000-0000-4000-8000-0000000000a1',
  writingLabel: 'Writing a summary…',
  failedLabel: 'The summary could not be written. Try again.',
} satisfies SummaryProps;

export const summaryStates = defineIslandStates({
  island: 'apps/web/app/posts/[id]/summary.island.tsx',
  viewport: { width: 480, height: 120 },
  states: [
    { id: 'idle', title: 'before the reader asks: a button and room for the text', props: BASE },
  ],
});
