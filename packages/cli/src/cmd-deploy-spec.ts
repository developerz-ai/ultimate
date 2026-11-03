// `x deploy`'s declaration, apart from its body: the parser, `x help` and the `errors` step
// read it without loading `cmd-deploy.ts`, which `registry.ts` imports only when the command runs.

import type { CommandSpec } from './parse';

export const deploySpec: CommandSpec = {
  name: 'deploy',
  summary: 'run the container deploy plan: migrate first, then the serving roles',
  usage:
    'x deploy --image repo/app:tag [--method compose|helm] [--release name] [--namespace ns] [--timeout 15m] [--dry-run] [--json] | x deploy verify --url <origin> [--build <id>] [--window 60s] [--interval 5s] [--timeout 10m] [--idle-ok <queue,…>] [--json]',
  requiresApp: true,
  // `up` is the parser's name for the bare form, so `x deploy --image …` stays the deploy. The usage
  // and every doc keep that one spelling.
  subcommands: ['up', 'verify'],
  defaultSubcommand: 'up',
  flags: [
    { name: 'image', type: 'string', summary: 'image reference to deploy', subcommands: ['up'] },
    {
      name: 'method',
      type: 'string',
      summary: 'compose | helm',
      default: 'compose',
      subcommands: ['up'],
    },
    {
      name: 'dry-run',
      type: 'boolean',
      summary: 'print the plan, run nothing',
      subcommands: ['up'],
    },
    {
      name: 'release',
      type: 'string',
      summary: 'helm release name (default: app.config.ts name)',
      subcommands: ['up'],
    },
    {
      name: 'namespace',
      type: 'string',
      summary: 'helm namespace (default: the kube context)',
      subcommands: ['up'],
    },
    {
      name: 'timeout',
      type: 'string',
      // No `default:` — the parser would then fill it on every compose deploy too, and the refusal
      // of a helm-only flag there could not tell an operator's value from its own.
      summary:
        'how long helm waits for the migrate hook and the rollout (default 15m); verify: the whole wait (default 10m)',
    },
    {
      name: 'url',
      type: 'string',
      summary: 'the origin to sample: /readyz behind the load balancer',
      subcommands: ['verify'],
    },
    {
      name: 'build',
      type: 'string',
      summary: "the build that must answer (default: x.manifest.json's buildId)",
      subcommands: ['verify'],
    },
    {
      name: 'window',
      type: 'string',
      summary: 'how long consecutive good samples must span (default 60s); 0: answered once',
      subcommands: ['verify'],
    },
    {
      name: 'interval',
      type: 'string',
      summary: 'the gap between samples (default 5s)',
      subcommands: ['verify'],
    },
    {
      name: 'idle-ok',
      type: 'string',
      summary: 'queues a scale-to-zero pool may leave unserved while their depth is 0',
      subcommands: ['verify'],
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
