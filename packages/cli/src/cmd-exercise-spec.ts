// `x exercise`'s declaration, apart from its body: the parser, `x help` and the `errors` step
// read it without loading `cmd-exercise.ts`, which `registry.ts` imports only when the command runs.

import type { CommandSpec } from './parse';

export const exerciseSpec: CommandSpec = {
  name: 'exercise',
  summary: 'run every action, query and job once on generated rows, with no test written',
  usage: 'x exercise [<name>] [--seed n|random] [--shard i/n] [--json]',
  requiresApp: true,
  flags: [
    {
      name: 'seed',
      type: 'string',
      summary:
        'the integer the seed graph and every generated input are drawn from; same seed, same pass. Default: one constant, so the gate is reproducible; random explores a fresh one and reports it',
    },
    {
      name: 'shard',
      type: 'string',
      summary:
        'i/n: run the i-th of n disjoint slices of the pass, written to .x/exercise.<i>-of-<n>.json; the floor is judged unsharded',
    },
  ],
};
