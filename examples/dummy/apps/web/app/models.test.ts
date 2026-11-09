/**
 * unit — Postly brings its own models: the framework registers none, so every prompt the app
 * declares names a row `models.ts` registered, and a real call through each model-backed action
 * resolves and prices on that row alone.
 */

import { configureAi, echoProvider, modelSpec, providerGateway } from '@ultimat3/ai';
import type { Gateway } from '@ultimat3/ai/adapter';
import { installAiGateway } from '@ultimat3/ai/adapter';
import { afterEach, expect, test } from '@ultimat3/testing';
import { APP_MODELS, CLAUDE_SONNET_5_5, claudeSonnet55 } from './models';
import { reviewDraft } from './posts/actions/review-draft';
import { summarize } from './posts/actions/summarize';
import { reviewDraftPrompt } from './posts/prompts/review-draft';
import { summarizePrompt } from './posts/prompts/summarize';

// The gateway is `aiGateway` in apps/web/runtime.ts at boot; a test installs its own through the
// adapter installer, and `configureAi()` still clears the semantic cache. Undone after each test.
const releases: (() => void)[] = [];
const useGateway = (gateway: Gateway): void => {
  configureAi();
  releases.push(installAiGateway(gateway));
};
afterEach(() => {
  for (const release of releases.splice(0).reverse()) release();
});

/** Every prompt artifact the app ships. A new one is added here with its eval. */
const PROMPTS = [summarizePrompt, reviewDraftPrompt];

test('the model the app names is the row the app registered', () => {
  // Identity, not equality: only the app's own `registerModel` puts THIS object in the catalogue.
  expect(modelSpec(CLAUDE_SONNET_5_5)).toBe(claudeSonnet55);
});

test('every prompt runs on the current Sonnet row, which refuses a forced tool choice', () => {
  for (const prompt of PROMPTS) expect(prompt.model).toBe(CLAUDE_SONNET_5_5);
  expect(claudeSonnet55).toMatchObject({
    forcedToolChoice: false,
    cacheReadPerMillion: { minor: 10, currency: 'USD' },
    cacheMinimumTokens: 512,
  });
});

test('every prompt names a model from app/models.ts', () => {
  const registered = new Set<unknown>(APP_MODELS);
  for (const prompt of PROMPTS) {
    expect(prompt.model).toBeDefined();
    expect(registered.has(modelSpec(prompt.model ?? ''))).toBe(true);
  }
});

test('the model-backed actions resolve and price on the app rows, with no gateway default', async ({
  seed,
  actorFor,
}) => {
  const reply = (prompt: string): string =>
    prompt.includes('editor of a team blog')
      ? JSON.stringify({ verdict: 'ready', notes: 'Ready.' })
      : JSON.stringify({ summary: 'Minor units and a currency.', tags: ['money'] });
  // No `defaultModel`: each declaration's prompt names its model, so the gateway is never asked.
  useGateway(providerGateway({ providers: [echoProvider({ fallback: reply })] }));
  const { draft, bruno } = await seed('dev').pick({
    draft: 'post:draft-money',
    bruno: 'member:bruno',
  });
  const input = { postId: draft.id, orgId: draft.orgId };

  expect(await summarize.as(actorFor(bruno), input)).toMatchObject({ tags: ['money'] });
  expect(await reviewDraft.as(actorFor(bruno), input)).toMatchObject({ verdict: 'ready' });
});
