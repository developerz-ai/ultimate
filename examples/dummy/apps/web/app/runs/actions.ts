/**
 * The runs feature's commands. Declarations only — every body delegates to `ctx.runs`, so the
 * same code runs whether the caller is the console, a machine holding a run key or an MCP agent.
 *
 * `orgId` is in every input because the policy decides on it, and the two commands that act on
 * ONE run load the fact their rule reads — the prompt's row, the run's row — before the guard: a
 * run id is a handle a caller typed, never evidence the run is theirs.
 *
 * `t` comes from @ultimat3/action, not @ultimat3/schema: an action file imports one package.
 */

import { action, t } from '@ultimat3/action';
import { ConnectInput, ConnectionView, RunKeyIssued, RunStarted } from './entity';
import { canRunAct, canRunKey, canRunKeyRevoke, canRunWrite } from './policy';

/** An answer is a short code a person typed; anything longer is not one. */
const ANSWER_MAX = 64;

export const connectSite = action({
  input: ConnectInput,
  output: ConnectionView,
  policy: canRunWrite,
  // No `mcp`: the input carries a credential, and an agent's transcript is the wrong place for one.
  async handle({ input, ctx }) {
    return ctx.runs.connect(input);
  },
});

export const startRun = action({
  input: t.object({ orgId: t.uuid, connectionId: t.uuid }),
  output: RunStarted,
  policy: canRunWrite,
  mcp: {
    expose: true,
    description:
      'Start one sync of a connection. Answers the run id its events and prompts are keyed by; a second run of a busy connection settles failed with X_JOB_KEY_BUSY',
  },
  async handle({ input, ctx }) {
    return ctx.runs.start(input.orgId, input.connectionId);
  },
});

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

export const cancelRun = action({
  input: t.object({ orgId: t.uuid, runId: t.uuid }),
  output: t.object({ runId: t.uuid }),
  policy: canRunAct,
  row: ({ input, ctx }) => ctx.runs.runOwner(input.runId),
  mcp: { expose: true, description: 'Cancel a run that is queued or in flight' },
  async handle({ input, ctx }) {
    await ctx.runs.cancel(input.runId);
    return { runId: input.runId };
  },
});

export const issueRunKey = action({
  input: t.object({ orgId: t.uuid }),
  output: RunKeyIssued,
  policy: canRunKey,
  // No `mcp`: the answer is a credential, shown once, and a tool result is kept in a transcript.
  async handle({ input, ctx }) {
    return ctx.runs.issueKey(input.orgId);
  },
});

export const revokeRunKey = action({
  input: t.object({ orgId: t.uuid, keyId: t.string.min(1) }),
  output: t.object({ revoked: t.boolean }),
  policy: canRunKeyRevoke,
  row: ({ input, ctx }) => ctx.runs.keyOwner(input.keyId),
  async handle({ input, ctx }) {
    return { revoked: await ctx.runs.revokeKey(input.keyId) };
  },
});
