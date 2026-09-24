// `x deploy`'s declaration, apart from its body: the parser, `x help` and the `errors` step
// read it without loading `cmd-deploy.ts`, which `registry.ts` imports only when the command runs.

import type { CommandSpec } from './parse';

export const deploySpec: CommandSpec = {
  name: 'deploy',
  summary: 'run the container deploy plan: migrate first, then the serving roles',
  usage:
    'x deploy --image repo/app:tag [--method compose|helm] [--release name] [--namespace ns] [--timeout 15m] [--dry-run] [--json]',
  requiresApp: true,
  flags: [
    { name: 'image', type: 'string', summary: 'image reference to deploy' },
    { name: 'method', type: 'string', summary: 'compose | helm', default: 'compose' },
    { name: 'dry-run', type: 'boolean', summary: 'print the plan, run nothing' },
    {
      name: 'release',
      type: 'string',
      summary: 'helm release name (default: app.config.ts name)',
    },
    { name: 'namespace', type: 'string', summary: 'helm namespace (default: the kube context)' },
    {
      name: 'timeout',
      type: 'string',
      // No `default:` — the parser would then fill it on every compose deploy too, and the refusal
      // of a helm-only flag there could not tell an operator's value from its own.
      summary: 'how long helm waits for the migrate hook and the rollout (default 15m)',
    },
    // `--critical` was here and is gone. It parsed, it was echoed into the plan JSON as
    // `critical: <bool>`, and no file in `packages/` read that field — so the flag changed
    // nothing about what `x deploy` did, on either method. `flag-reads.ts`'s
    // `X_CLI_FLAG_UNREAD` passed it, because that gate proves a flag is READ and this one was:
    // into a field with no reader. It is not coming back: `@ultimat3/pwa`'s
    // `updateSignal({ reason: 'security' })`, the call it was to have triggered, is **deleted**
    // as of 9.0.0 for having had no runtime caller of its own, and nothing in the framework
    // force-navigates a client. A deploy also has no channel to one — the plan is
    // `docker compose up` / `helm upgrade`, and the client's build id is read by `http` (tier 2)
    // and `sync` (tier 3), neither of which may import a tier-4 package to act on it.
  ],
};
