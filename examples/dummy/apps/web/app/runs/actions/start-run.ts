// `startRun`, the runs slice's action — one primitive per file, the layout `x g` writes.
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
import { RunStarted } from '../entity';
import { canRunWrite } from '../policy';

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
