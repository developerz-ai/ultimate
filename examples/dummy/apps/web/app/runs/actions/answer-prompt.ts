// `answerPrompt`, the runs slice's action — one primitive per file, the layout `x g` writes.
//
// The runs feature's commands. Declarations only — every body delegates to `ctx.runs`, so the
// same code runs whether the caller is the console, a machine holding a run key or an MCP agent.
//
// `orgId` is in every input because the policy decides on it, and the two commands that act on
// ONE run load the fact their rule reads — the prompt's row, the run's row — before the guard: a
// run id is a handle a caller typed, never evidence the run is theirs.
//
// `t` comes from @ultimat3/action, not @ultimat3/schema: an action file imports one package.

import { action, t } from '@ultimat3/action';
import { canRunAct } from '../policy';

/** An answer is a short code a person typed; anything longer is not one. */
const ANSWER_MAX = 64;

export const answerPrompt = action({
  input: t.object({
    orgId: t.uuid,
    runId: t.uuid,
    prompt: t.number.int().min(1),
    answer: t.string.min(1).max(ANSWER_MAX),
  }),
  output: t.object({ runId: t.uuid, prompt: t.number.int() }),
  policy: canRunAct,
  row: ({ input, ctx }) => ctx.runs.promptOwner(input.runId, input.prompt),
  mcp: {
    expose: true,
    description:
      'Answer the prompt a run is waiting on — the code the site asked for. The run resumes with its browser still open',
  },
  async handle({ input, ctx }) {
    await ctx.runs.answer(input.runId, input.prompt, input.answer);
    return { runId: input.runId, prompt: input.prompt };
  },
});
