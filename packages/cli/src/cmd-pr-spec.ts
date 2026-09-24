// `x pr`'s declaration, apart from its body: the parser, `x help` and the `errors` step
// read it without loading `cmd-pr.ts`, which `registry.ts` imports only when the command runs.

import type { CommandSpec } from './parse';

export const PR_SUBCOMMANDS = ['review', 'resolve', 'reply'] as const;

export const prSpec: CommandSpec = {
  name: 'pr',
  summary: 'inline review threads: list them with their ids, resolve one, reply in one',
  usage:
    'x pr review [--pr <n>] [--repo owner/name] [--all] [--full] | x pr resolve <thread-id> | x pr reply <thread-id> --body "…"',
  subcommands: PR_SUBCOMMANDS,
  flags: [
    { name: 'repo', type: 'string', summary: 'owner/name; the checkout own remote by default' },
    { name: 'pr', type: 'string', summary: 'pull request number; this branch own by default' },
    // Scoped to the subcommand each summary already names: `resolve` and `reply` WRITE to
    // somebody else's pull request, and a flag they silently ignore is a flag whose caller
    // believed it did something to a request that cannot be re-run.
    {
      name: 'all',
      type: 'boolean',
      summary: 'review: resolved threads too, not just open ones',
      subcommands: ['review'],
    },
    {
      name: 'full',
      type: 'boolean',
      summary: 'review: whole comment bodies, never truncated',
      subcommands: ['review'],
    },
    {
      name: 'body',
      type: 'string',
      summary: 'reply: the comment text to post in the thread',
      subcommands: ['reply'],
    },
  ],
};
