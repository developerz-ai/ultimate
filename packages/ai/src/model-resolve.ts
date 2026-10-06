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

/**
 * The same answer WITHOUT recording, for a fact published about a declaration (`describeAgents()`),
 * which is read at describe time with no gateway in hand: recording there would warn an app whose
 * gateway does declare a `defaultModel`, telling it to do what it already did.
 */
export function describedModel(...candidates: readonly (ModelId | undefined)[]): ModelId {
  for (const candidate of candidates) if (candidate !== undefined) return candidate;
  return DEFAULT_MODEL;
}
