/**
 * unit — Postly brings its own models (plan 101, B23): every prompt the app declares names a row
 * `models.ts` registered, and a real call through each model-backed action prices and resolves
 * without the framework's built-in catalogue, which `@ultimat3/ai` records as `ai.deprecation`.
 */

import { configureAi, createGateway, EchoProvider, modelSpec } from '@ultimat3/ai';
import { setLogSink } from '@ultimat3/core';
import { afterEach, beforeEach, expect, test } from '@ultimat3/testing';
import { APP_MODELS, CLAUDE_SONNET_5, claudeSonnet5 } from './models';
import { reviewDraft, summarize } from './posts/actions';
import { reviewDraftPrompt } from './posts/prompts/review-draft';
import { summarizePrompt } from './posts/prompts/summarize';

/** Every prompt artifact the app ships. A new one is added here with its eval. */
const PROMPTS = [summarizePrompt, reviewDraftPrompt];

let lines: Record<string, unknown>[] = [];
let previous: ReturnType<typeof setLogSink>;
beforeEach(() => {
  lines = [];
  previous = setLogSink((line) => {
    lines.push(JSON.parse(line) as Record<string, unknown>);
  });
});
afterEach(() => {
  setLogSink(previous);
});

test('the model the app names is the row the app registered, not a built-in one', () => {
  // Identity, not equality: the built-in row carries the same numbers, and only the app's own
  // `registerModel` puts THIS object in the catalogue.
  expect(modelSpec(CLAUDE_SONNET_5)).toBe(claudeSonnet5);
});

test('every prompt names a model from app/models.ts', () => {
  const registered = new Set<unknown>(APP_MODELS);
  for (const prompt of PROMPTS) {
    expect(prompt.model).toBeDefined();
    expect(registered.has(modelSpec(prompt.model ?? ''))).toBe(true);
  }
});

test('the model-backed actions resolve and price with no deprecated fallback', async ({
  seed,
  actorFor,
}) => {
  const reply = (prompt: string): string =>
    prompt.includes('editor of a team blog')
      ? JSON.stringify({ verdict: 'ready', notes: 'Ready.' })
      : JSON.stringify({ summary: 'Minor units and a currency.', tags: ['money'] });
  configureAi({ gateway: createGateway({ providers: [new EchoProvider({ fallback: reply })] }) });
  const { draft, bruno } = await seed('dev').pick({
    draft: 'post:draft-money',
    bruno: 'member:bruno',
  });
  const input = { postId: draft.id, orgId: draft.orgId };

  await summarize.as(actorFor(bruno), input);
  await reviewDraft.as(actorFor(bruno), input);

  expect(lines.filter((line) => line['msg'] === 'ai.deprecation')).toEqual([]);
});
