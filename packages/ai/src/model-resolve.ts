// The ONE fallback to the built-in `DEFAULT_MODEL`. Every site that resolves a model with nothing
// declared — `llm()`, `agent()`, the gateway, the providers — asks here, so the deprecation is
// recorded in one place and the 25.0.0 removal is one edit: this file refuses instead of answering.

import { type ModelSite, recordDefaultModel } from './deprecations';
import { DEFAULT_MODEL, type ModelId } from './models';

/**
 * The first declared candidate, in the caller's precedence order (a declaration, then its prompt,
 * then the gateway's `defaultModel`). None declared: the built-in default, recorded as deprecated
 * once for `site`.
 */
export function resolveModel(
  site: ModelSite,
  ...candidates: readonly (ModelId | undefined)[]
): ModelId {
  for (const candidate of candidates) if (candidate !== undefined) return candidate;
  recordDefaultModel(site, DEFAULT_MODEL);
  return DEFAULT_MODEL;
}

/** Which of the app's places a model came from — or the deprecated built-in, when none. */
export type ModelSource = 'declaration' | 'prompt' | 'gateway' | 'built-in-default';

const SOURCES: readonly ModelSource[] = ['declaration', 'prompt', 'gateway'];

/**
 * The same answer as `resolveModel`, over the same three candidates in the same order, WITHOUT
 * recording — and with where it came from. For a fact published about a declaration
 * (`describeAgents()`): a reader describing an app is not a call leaning on the default, and
 * recording there would warn an app that has already chosen.
 */
export function describedModel(
  declared: ModelId | undefined,
  prompt: ModelId | undefined,
  gateway: ModelId | undefined,
): { readonly model: ModelId; readonly from: ModelSource } {
  const candidates = [declared, prompt, gateway];
  for (const [at, candidate] of candidates.entries()) {
    const from = SOURCES[at];
    if (candidate !== undefined && from !== undefined) return { model: candidate, from };
  }
  return { model: DEFAULT_MODEL, from: 'built-in-default' };
}
