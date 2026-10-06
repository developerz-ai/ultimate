/**
 * The prompt artifact behind the `reviewDraft` agent (`../actions.ts`), and nothing else — the
 * same split `summarize.ts` makes: the agent is an action and lives with the actions; the artifact,
 * its eval and its recorded baseline live here.
 */

import { definePrompt } from '@ultimat3/ai';
import { CLAUDE_SONNET_5 } from '../../models';
import { reviewDraftTemplate } from './review-draft-template';

/** Editing the template requires bumping this version — it keys the traces and the baseline. */
export const reviewDraftPrompt = definePrompt({
  id: 'posts.review-draft',
  version: '1',
  template: reviewDraftTemplate,
  // Imported, never spelled: the app registers every model it names (`app/models.ts`).
  model: CLAUDE_SONNET_5,
  input: {
    type: 'object',
    properties: { title: { type: 'string' }, body: { type: 'string' }, locale: { type: 'string' } },
    required: ['title', 'body', 'locale'],
  },
  output: {
    type: 'object',
    properties: {
      verdict: { type: 'string', enum: ['ready', 'revise'] },
      notes: { type: 'string' },
    },
    required: ['verdict', 'notes'],
  },
});
