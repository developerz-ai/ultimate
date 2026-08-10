/**
 * The prompt artifact behind `summarize`, and nothing else.
 *
 * A versioned artifact, not a string literal: `definePrompt` hashes the template into the
 * prompt's identity, which keys the semantic cache and appears in every trace, so a summary can
 * always be attributed to the exact text that produced it. Bumping `version` changes the hash.
 *
 * The `llm()` declaration that uses it lives in `../actions.ts`, because `llm()` returns an
 * `action` and an action is only ever declared in `api/` or a feature's `actions.ts`. What lives
 * beside this file is the rest of the artifact: `summarize.v4.md`, `summarize.evals.ts` and
 * `summarize.v4.baseline.json`. Earlier versions (`summarize.v3.md`, its baseline) stay on disk
 * unchanged — old traces cite them, and rollback is a version number, not a restore from git.
 */

import { definePrompt } from '@ultimat3/ai';
import { summarizeTemplate } from './summarize-template';

/** Editing the markdown requires bumping this version — it keys the cache and the traces. */
export const summarizePrompt = definePrompt({
  id: 'posts.summarize',
  version: '4',
  template: summarizeTemplate,
  model: 'claude-sonnet-5',
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
