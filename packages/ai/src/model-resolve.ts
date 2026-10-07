// Which model a call runs on, decided in ONE place. The app names it in one of three places — the
// declaration's `model`, its prompt's, `createGateway({ defaultModel })` — and the framework has
// no fourth: a call that names none is refused here, naming all three, never routed to a vendor.

import { UltimateError } from '@ultimat3/core';
import type { ModelId } from './models';
import { aiGateway } from './runtime';

/** Where a model was resolved. Bounded, and the first word of the refusal's cause. */
export type ModelSite = 'llm' | 'agent' | 'gateway' | 'provider' | 'echo-provider';

/** The three places, spelled once so the refusal and the docs cannot drift apart. */
const PLACES =
  'model: modelId on the llm()/agent() declaration, model: modelId in its definePrompt, or createGateway({ …, defaultModel: modelId })';

/**
 * The first declared candidate, in the caller's precedence order (a declaration, then its prompt,
 * then the gateway's `defaultModel`). None declared is `X_AI_MODEL_UNRESOLVED`: which model, and so
 * which vendor, is the app's call and never the framework's.
 */
export function resolveModel(
  site: ModelSite,
  ...candidates: readonly (ModelId | undefined)[]
): ModelId {
  for (const candidate of candidates) if (candidate !== undefined) return candidate;
  throw new AiModelUnresolvedError(site);
}

/** A call that named no model: its own code, because the fix is a declaration, not a request. */
export class AiModelUnresolvedError extends UltimateError {
  constructor(site: ModelSite) {
    super({
      code: 'X_AI_MODEL_UNRESOLVED',
      cause: `${site} resolved no model: no declaration, prompt or createGateway({ defaultModel }) named one, and the framework chooses none (modelId: an id your app registerModel-ed and a configured provider lists)`,
      fix: `${PLACES}   # one of the three`,
    });
  }
}

/**
 * The model an `llm()` or `agent()` call runs on. The gateway is asked only when neither the
 * declaration nor its prompt names one — and with none installed that is `X_AI_GATEWAY_MISSING`
 * for `prompt`, because the third place does not exist yet: the boot call is the whole fix.
 */
export function modelForCall(
  site: 'llm' | 'agent',
  prompt: string,
  declared: ModelId | undefined,
  promptModel: ModelId | undefined,
): ModelId {
  if (declared !== undefined || promptModel !== undefined) {
    return resolveModel(site, declared, promptModel);
  }
  return resolveModel(site, aiGateway(prompt).defaultModel);
}

/** Which of the app's three places a model came from. */
export type ModelSource = 'declaration' | 'prompt' | 'gateway';

const SOURCES: readonly ModelSource[] = ['declaration', 'prompt', 'gateway'];

/**
 * The same answer as `resolveModel`, over the same three candidates in the same order, WITHOUT
 * refusing — and with where it came from. For a fact published about a declaration
 * (`describeAgents()`): a reader describing an app is not a call, so a declaration that names no
 * model yet (the gateway is installed later) is described as `undefined`, never thrown over.
 */
export function describedModel(
  declared: ModelId | undefined,
  prompt: ModelId | undefined,
  gateway: ModelId | undefined,
): { readonly model: ModelId | undefined; readonly from: ModelSource | undefined } {
  const candidates = [declared, prompt, gateway];
  for (const [at, candidate] of candidates.entries()) {
    const from = SOURCES[at];
    if (candidate !== undefined && from !== undefined) return { model: candidate, from };
  }
  return { model: undefined, from: undefined };
}
