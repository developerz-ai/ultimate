// The vendor data this package still ships, and the once-per-process notice that an app leans on
// it: the built-in `DEFAULT_MODEL` fallback and the built-in catalogue rows. Both are removed in
// 25.0.0 — an app registers its models and picks its provider. One file so the two notices share
// one shape, one dedupe and one way out (`resetAiDeprecations`, for tests).

import { counter, logger } from '@ultimat3/core';
import { isBuiltInRow } from './model-origin';
import type { ModelId, ModelSpec } from './models';

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
 * A model was resolved with none declared, at `site`, so the built-in default answered. The fix is
 * the shape of the two app-side places a model is chosen, and the cause says what `modelId` is —
 * never a model of its own: which one is the app's call.
 */
export function recordDefaultModel(site: ModelSite, model: ModelId): void {
  record('default-model', site, {
    site,
    model,
    cause: `${site} resolved no model — no declaration, prompt or createGateway({ defaultModel }) named one — so the built-in "${model}" answered (modelId: an id your app registerModel-ed and a configured provider lists)`,
    fix: 'createGateway({ …, defaultModel: modelId })   # your existing call — or model: modelId on the llm()/agent() declaration',
  });
}

/**
 * A row as the TypeScript an app pastes: identifier keys, `undefined` kept (a `reasoning` key the
 * type requires even when unset), every value the built-in row holds — so the paste re-registers
 * exactly what is priced today, and the app edits the prices to its contract from there.
 */
function literal(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return `[${value.map(literal).join(', ')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value).map(([key, inner]) => `${key}: ${literal(inner)}`);
    return `{ ${entries.join(', ')} }`;
  }
  return typeof value === 'string' ? `'${value}'` : String(value);
}

/**
 * `spec` priced a call and is a row this package registered, not the app. Recorded once per ROW,
 * because the fix is that row's own `registerModel`: the row written out whole, runnable as pasted.
 */
export function recordBuiltInPrice(spec: ModelSpec): void {
  if (!isBuiltInRow(spec.id)) return;
  record('built-in-price', spec.id, {
    model: spec.id,
    cause: `"${spec.id}" was priced by the built-in catalogue row, which the app never registered (removed in ${REMOVED_IN}); the fix is that row as it stands — set the prices to your contract's`,
    fix: `registerModel(${literal(spec)})   # at boot, before configureAi; this row's ai.deprecation line then stops`,
  });
}

/** Test-only: forget what was said, so each test sees its own first time. */
export function resetAiDeprecations(): void {
  said.clear();
}
