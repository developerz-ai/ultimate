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
  }) {
    super({
      code: 'X_LLM_TOOL_ARGUMENTS_INVALID',
      cause: `model "${input.model}" on provider "${input.provider}" finished its turn calling tool "${input.tool}" with ${input.chars} characters of arguments that are not JSON`,
      fix: `retry: { attempts: 2 }   # on the job that runs this call — the same request can succeed; if it repeats, shorten or split the string fields in the input schema of "${input.tool}", the place a model breaks JSON`,
      meta: {
        provider: input.provider,
        model: input.model,
        tool: input.tool,
        [BILLED_META]: input.billed,
      },
    });
  }
}
