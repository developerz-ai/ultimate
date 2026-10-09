/**
 * The prompt artifact behind `summarize`, and nothing else.
 *
 * A versioned artifact, not a string literal: `definePrompt` hashes the template into the
 * prompt's identity, which keys the semantic cache and appears in every trace, so a summary can
 * always be attributed to the exact text that produced it. Bumping `version` changes the hash.
 *
 * The `llm()` declaration that uses it lives in `../actions/summarize.ts`, because `llm()` returns
 * an `action` and an action is only ever declared in a feature's `actions/`. What lives
 * beside this file is the rest of the artifact: `summarize.v5.md`, `summarize.evals.ts` and
 * `summarize.v5.baseline.json`. Earlier versions (`summarize.v3.md`, `summarize.v4.md`, their
 * baselines) stay on disk unchanged — old traces cite them, and rollback is a version number, not a restore from git.
 */

import { definePrompt } from '@ultimat3/ai';
import { CLAUDE_SONNET_5 } from '../../models';
import { summarizeTemplate } from './summarize-template';

/** Editing the markdown requires bumping this version — it keys the cache and the traces. */
export const summarizePrompt = definePrompt({
  id: 'posts.summarize',
  version: '5',
  template: summarizeTemplate,
  // Imported, never spelled: the app registers every model it names (`app/models.ts`).
  model: CLAUDE_SONNET_5,
  input: {
    type: 'object',
    properties: { title: { type: 'string' }, body: { type: 'string' }, locale: { type: 'string' } },
    required: ['title', 'body', 'locale'],
  },
  output: {
    type: 'object',
    properties: { summary: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } } },
    required: ['summary', 'tags'],
  },
});
