// `x token`'s declaration, apart from its body: the parser, `x help` and the `errors` step
// read it without loading `cmd-token.ts`, which `registry.ts` imports only when the command runs.

import type { CommandSpec } from './parse';

/** `grant` stays listed and answers X_NOT_IMPLEMENTED (`PLANNED_SUBCOMMANDS`): a key's scopes are fixed. */
export const TOKEN_SUBCOMMANDS = ['create', 'list', 'revoke', 'grant'] as const;

/** The longest lifetime `--days` takes: ten years is "no expiry" said out loud. */
export const TOKEN_MAX_DAYS = 3_650;

export const tokenSpec: CommandSpec = {
  name: 'token',
  summary: 'MCP and API tokens: issue one with exact scopes, list them by owner, revoke one',
  usage:
    'x token create --scopes <a,b> [--user <id>] [--org <id>] [--env dev|stage|prod] [--days n] · x token list --owner <id> · x token revoke <id> [--json]',
  requiresApp: true,
  // No default: `create` WRITES a credential, and a bare `x token` must not.
  subcommands: [...TOKEN_SUBCOMMANDS],
  flags: [
    {
      name: 'scopes',
      type: 'string',
      summary: 'comma-separated permissions the token carries, each by name — never a wildcard',
      subcommands: ['create'],
    },
    {
      name: 'user',
      type: 'string',
      summary: 'the user the token belongs to: its scopes are cut to what that user may do',
      subcommands: ['create'],
    },
    { name: 'org', type: 'string', summary: 'the org the token acts in', subcommands: ['create'] },
    {
      name: 'env',
      type: 'string',
      summary:
        "the label inside the token (ult_<env>_…): dev, stage, prod — default: the environment's (ULTIMATE_ENV production → prod, staging → stage, else dev)",
      subcommands: ['create'],
    },
    {
      name: 'days',
      type: 'string',
      summary: `days until the token expires, 1 to ${TOKEN_MAX_DAYS} (default: never)`,
      subcommands: ['create'],
    },
    {
      name: 'owner',
      type: 'string',
      summary: 'list the tokens of this user or org id',
      subcommands: ['list'],
    },
  ],
};
