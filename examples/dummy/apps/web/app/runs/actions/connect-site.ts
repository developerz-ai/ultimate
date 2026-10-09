// `connectSite`, the runs slice's action — one primitive per file, the layout `x g` writes.
//
// The runs feature's commands. Declarations only — every body delegates to `ctx.runs`, so the
// same code runs whether the caller is the console, a machine holding a run key or an MCP agent.
//
// `orgId` is in every input because the policy decides on it, and the two commands that act on
// ONE run load the fact their rule reads — the prompt's row, the run's row — before the guard: a
// run id is a handle a caller typed, never evidence the run is theirs.
//
// `t` comes from @ultimat3/action, not @ultimat3/schema: an action file imports one package.

import { action } from '@ultimat3/action';
import { ConnectInput, ConnectionView } from '../entity';
import { canRunWrite } from '../policy';

export const connectSite = action({
  input: ConnectInput,
  output: ConnectionView,
  policy: canRunWrite,
  // No `mcp`: the input carries a credential, and an agent's transcript is the wrong place for one.
  async handle({ input, ctx }) {
    return ctx.runs.connect(input);
  },
});
