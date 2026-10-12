// The two failures of an answer that ARRIVED and cannot be used: cut off at the ceiling, or a tool
// call whose arguments do not parse. Apart from ./errors only because one file has one job and
// that catalogue is at its line ceiling — the split `hive-errors.ts` and `agent-errors.ts` made.
// The codes, their titles and the single `registerErrorCodes` call stay in ./errors.

import { UltimateError } from '@ultimat3/core';
import type { Billed } from './billed';
import { BILLED_META } from './billed';

/**
 * The answer was cut off at the enforced ceiling. Thrown BEFORE the answer is read, and instead of
 * a repair turn: a cut-off `respond` call arrives with no arguments, which both wires read as `{}`
 * and an `output` of optional keys accepts — and the ceiling does not move between attempts, so a
 * second answer truncates at exactly the same place and only spends money.
 */
export class LlmTruncatedError extends UltimateError {
  constructor(input: {
    prompt: string;
    maxTokens: number;
    /** The factory whose declaration carries the ceiling. */
    subject?: 'llm' | 'agent';
  }) {
    super({
      code: 'X_LLM_TRUNCATED',
      cause: `prompt "${input.prompt}" was cut off at its ${input.maxTokens}-token ceiling`,
      fix: `maxTokens: ${input.maxTokens * 2}   # on the ${input.subject ?? 'llm'}() declaration — or drop fields from its output schema`,
      meta: { prompt: input.prompt, maxTokens: input.maxTokens },
    });
  }
}

/**
 * The model finished its turn and the arguments of a tool call it made are not JSON. Not a
 * transport failure: the provider answered, the answer was billed, and asking the next provider
 * (or the same one three more times) buys the same request again. So it is its own code, the
 * gateway does not retry it, and it carries the bill.
 *
 * The cause never quotes the arguments. They are the model's text, and for `respond` they are the
 * answer — which is where whatever the prompt loaded ends up.
 */
export class LlmToolArgumentsError extends UltimateError {
  constructor(input: {
    provider: string;
    model: string;
    tool: string;
    chars: number;
    billed: Billed;
    /** Fragments with no index and no id: two calls merged, not one call broken. */
    unkeyed?: boolean;
  }) {
    super({
      code: 'X_LLM_TOOL_ARGUMENTS_INVALID',
      cause:
        input.unkeyed === true
          ? `provider "${input.provider}" streamed tool-call fragments for model "${input.model}" with no index and no id, and more than one of them named a tool — the calls cannot be told apart, so none was run`
          : `model "${input.model}" on provider "${input.provider}" finished its turn calling tool "${input.tool}" with ${input.chars} characters of arguments that are not JSON`,
      fix: `maxTokens: 8192   # on the declaration, if the arguments were long — and shorten or split the string fields in the input schema of "${input.tool}", the place a model breaks JSON. Terminal for a job: to run the same request once more, catch this code and re-enqueue it deliberately`,
      meta: {
        provider: input.provider,
        model: input.model,
        tool: input.tool,
        [BILLED_META]: input.billed,
      },
    });
  }
}

/**
 * A chat-completions endpoint finished a turn with a reason this build does not know, and the turn
 * is not whole — a tool call whose arguments do not parse — or the reason was `error`. Not
 * truncation (nothing says the ceiling was reached) and not a transport failure (the endpoint
 * answered, and billed): its own code, carrying the reason and the bill.
 */
export class AiProviderUnexpectedError extends UltimateError {
  constructor(input: { provider: string; model: string; reason: string; billed: Billed }) {
    super({
      code: 'X_AI_PROVIDER_UNEXPECTED',
      cause: `provider "${input.provider}" finished a turn of model "${input.model}" with the finish reason ${JSON.stringify(input.reason.slice(0, 64))}, which this build does not know, and the answer is not complete`,
      fix: "x doctor --json   # then check what the endpoint means by the reason in cause: a truncation needs a higher maxTokens on the declaration, anything else is the endpoint's to explain",
      meta: {
        provider: input.provider,
        model: input.model,
        reason: input.reason.slice(0, 64),
        [BILLED_META]: input.billed,
      },
    });
  }
}
