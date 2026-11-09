// api/ holds actions only: no rendering, no components. This one is the readiness probe every
// role exposes, declared as an action so it appears in OpenAPI and MCP like everything else.

import { action, t } from '@ultimat3/action';
import { allow } from '@ultimat3/policy';

export const health = action({
  input: t.object({}),
  output: t.object({ ok: t.boolean, role: t.string }),
  // Public, said out loud. `can('x:y')` is the other branch; a missing policy is a build error,
  // so "anyone may call this" has to be a declaration too.
  policy: allow('public'),
  mcp: { expose: true, description: 'Readiness of this process' },
  async handle({ ctx }) {
    return { ok: true, role: ctx.role };
  },
});
