// The X_* codes owned by @ultimat3/ai. Budget and threshold failures name the exact knob to
// change, because the caller is often a CI job with no human attached.

import { UltimateError } from '@ultimat3/core';

export const AI_ERROR_CODES = [
  'X_AI_PROVIDER_UNAVAILABLE',
  'X_AI_BUDGET_EXCEEDED',
  'X_AI_PROMPT_VERSION',
  'X_EVAL_THRESHOLD',
  'X_VECTOR_DIM_MISMATCH',
  'X_NOT_IMPLEMENTED',
] as const;

export type AiErrorCode = (typeof AI_ERROR_CODES)[number];

const docsFor = (code: AiErrorCode): string => `https://ultimate.dev/errors/${code}`;

/** Every configured provider refused or errored. Carries what each one said. */
export class AiProviderUnavailableError extends UltimateError {
  constructor(input: { model: string; attempts: readonly string[] }) {
    super({
      code: 'X_AI_PROVIDER_UNAVAILABLE',
      cause: `no provider could serve model "${input.model}" (${input.attempts.join(' | ')})`,
      fix: 'check ai.providers in app.config.ts and the provider API key env var',
      docs: docsFor('X_AI_PROVIDER_UNAVAILABLE'),
    });
  }
}

/**
 * A request would exceed its token budget. Thrown BEFORE the call, so nothing is spent and
 * nothing is silently truncated — a truncated prompt produces a confidently wrong answer,
 * which is worse than a refusal.
 */
export class AiBudgetExceededError extends UltimateError {
  constructor(input: {
    scope: string;
    requested: number;
    remaining: number;
    limit: number;
  }) {
    super({
      code: 'X_AI_BUDGET_EXCEEDED',
      cause:
        `request needs ${input.requested} tokens but scope "${input.scope}" has ` +
        `${input.remaining} of ${input.limit} left`,
      fix: `raise ai.budget for "${input.scope}" in app.config.ts, or shorten the prompt`,
      docs: docsFor('X_AI_BUDGET_EXCEEDED'),
    });
  }
}

/** A prompt was requested at a version whose content hash does not match the registry. */
export class AiPromptVersionError extends UltimateError {
  constructor(input: { id: string; requested: string; available: readonly string[] }) {
    super({
      code: 'X_AI_PROMPT_VERSION',
      cause: `prompt "${input.id}" has no version "${input.requested}" (have: ${
        input.available.length > 0 ? input.available.join(', ') : 'none'
      })`,
      fix: 'bump the version in definePrompt after editing the template, then x manifest',
      docs: docsFor('X_AI_PROMPT_VERSION'),
    });
  }
}

/**
 * A prompt was rendered with variables its template does not accept. Shares
 * `X_AI_PROMPT_VERSION` because it is the same class of fault: the prompt artifact and the
 * call site disagree about the prompt's contract.
 */
export class AiPromptRenderError extends UltimateError {
  constructor(input: { ref: string; missing: readonly string[] }) {
    super({
      code: 'X_AI_PROMPT_VERSION',
      cause: `prompt "${input.ref}" was rendered without: ${input.missing.join(', ')}`,
      fix: 'pass every {{variable}} the template declares, or remove it from the template',
      docs: docsFor('X_AI_PROMPT_VERSION'),
    });
  }
}

/** An eval scored below its declared threshold. This is a test failure, not a warning. */
export class EvalThresholdError extends UltimateError {
  constructor(input: {
    eval: string;
    score: number;
    threshold: number;
    promptVersion: string;
    worst: readonly string[];
  }) {
    super({
      code: 'X_EVAL_THRESHOLD',
      cause:
        `eval "${input.eval}" scored ${input.score.toFixed(3)} against a threshold of ` +
        `${input.threshold.toFixed(3)} on prompt version ${input.promptVersion}; ` +
        `worst cases: ${input.worst.join(', ')}`,
      fix: `x ai eval ${input.eval} --verbose to see per-case scores, then fix the prompt or lower the threshold deliberately`,
      docs: docsFor('X_EVAL_THRESHOLD'),
    });
  }
}

/** A vector's length does not match the store's declared dimension. */
export class VectorDimMismatchError extends UltimateError {
  constructor(input: { store: string; expected: number; received: number }) {
    super({
      code: 'X_VECTOR_DIM_MISMATCH',
      cause: `store "${input.store}" expects ${input.expected} dimensions, got ${input.received}`,
      fix: 'use the same embedder that created the store, or x ai reindex to rebuild it',
      docs: docsFor('X_VECTOR_DIM_MISMATCH'),
    });
  }
}

/** A remote driver whose transport or credential is not wired up. */
export class AiNotImplementedError extends UltimateError {
  constructor(input: { feature: string; fix: string }) {
    super({
      code: 'X_NOT_IMPLEMENTED',
      cause: `${input.feature} is declared but not implemented in @ultimat3/ai`,
      fix: input.fix,
      docs: docsFor('X_NOT_IMPLEMENTED'),
    });
  }
}
