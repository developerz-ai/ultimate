// `x explain`'s declaration, apart from its body: the parser, `x help` and the `errors` step
// read it without loading `cmd-explain.ts`, which `registry.ts` imports only when the command runs.

import type { CommandSpec } from './parse';

export const explainSpec: CommandSpec = {
  name: 'explain',
  summary:
    "one declared query's SQL, planned on the dev database by the exercise gate's plan oracle",
  usage: "x explain <query> [--input '<json>'] [--org <id>] [--json]",
  requiresApp: true,
  flags: [
    {
      name: 'input',
      type: 'string',
      summary: "the query's input as JSON, parsed by its own schema (default {})",
    },
    {
      name: 'org',
      type: 'string',
      summary: 'the tenant the read runs in — required when it reads a tenant-scoped entity',
    },
  ],
};
