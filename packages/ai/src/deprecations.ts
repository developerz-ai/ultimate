// The vendor data this package still ships, and the once-per-process notice that an app leans on
// it: the built-in `DEFAULT_MODEL` fallback and the built-in catalogue rows. Both are removed in
// 25.0.0 — an app registers its models and picks its provider. One file so the two notices share
// one shape, one dedupe and one way out (`resetAiDeprecations`, for tests).

import { counter, logger } from '@ultimat3/core';
import { isBuiltInRow } from './model-origin';
import type { ModelId } from './models';

/** What the app leaned on. Bounded: two kinds. */
export type AiDeprecationKind = 'default-model' | 'built-in-price';

/** Where a model was resolved with nothing declared. Bounded, so a series per site is safe. */
export type ModelSite = 'llm' | 'agent' | 'gateway' | 'provider' | 'echo-provider';

/** The release that deletes both. Spelled once, so every fix line names the same one. */
const REMOVED_IN = '25.0.0';

/**
 * Every use is counted — the number "can we delete it yet?" needs — while the log line below is
 * written once. Attributes are the kind and a bounded subject (a site, or a catalogue row id).
 */
const deprecatedUses = counter('ai_deprecated_fallbacks_total', {
  unit: '{call}',
  description: 'Model calls that resolved through built-in vendor data removed in 25.0.0',
});

const said = new Set<string>();

function record(
  kind: AiDeprecationKind,
  subject: string,
  fields: Readonly<Record<string, string>>,
): void {
  deprecatedUses.add(1, { kind, subject });
  const key = `${kind}:${subject}`;
  if (said.has(key)) return;
  said.add(key);
  logger.warn('ai.deprecation', { kind, ...fields, removedIn: REMOVED_IN });
}

/**
 * A model was resolved with none declared, at `site`, so the built-in default answered. The fix
 * names the two app-side places a model is chosen, and no model: which one is the app's call.
 */
export function recordDefaultModel(site: ModelSite, model: ModelId): void {
  record('default-model', site, {
    site,
    model,
    fix: `createGateway({ providers, defaultModel: '<your model id>' }), or model: '<your model id>' on the llm()/agent() declaration — the built-in default is removed in ${REMOVED_IN}`,
  });
}

/**
 * `model` was priced by a row this package registered, not the app. Recorded once per ROW, because
 * the fix is that row's own `registerModel`, with the prices the app's contract names.
 */
export function recordBuiltInPrice(model: ModelId): void {
  if (!isBuiltInRow(model)) return;
  record('built-in-price', model, {
    model,
    fix: `registerModel({ id: '${model}', contextWindow, maxOutput, inputPerMillion, outputPerMillion, cacheMinimumTokens, reasoning }) at boot — built-in catalogue rows are removed in ${REMOVED_IN}`,
  });
}

/** Test-only: forget what was said, so each test sees its own first time. */
export function resetAiDeprecations(): void {
  said.clear();
}
