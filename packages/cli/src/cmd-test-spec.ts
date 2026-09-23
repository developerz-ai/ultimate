// `x test`'s declaration, apart from its body: the parser, `x help` and the `errors` step
// read it without loading `cmd-test.ts`, which `registry.ts` imports only when the command runs.

import { TEST_TYPES } from '@ultimat3/testing/test-types';
import { DEFAULT_BASE } from './affected';
import type { CommandSpec } from './parse';
import { SERIAL_TYPES, WORKER_CEILING, WORKER_FLOOR, WORKER_OVERSUBSCRIBE } from './test-workers';

export const testSpec: CommandSpec = {
  name: 'test',
  summary:
    'run one test type — or the whole suite — across N workers, one isolated database per worker',
  usage: `x test [${TEST_TYPES.join('|')}] [--filter text] [--sample N] [--affected [--base ref] [--dirty]] [--workers N] [--worker I] [--json] [-- <bun test flags>]`,
  positionalChoices: TEST_TYPES,
  // The one command that hands a tail to another tool — `bun test` — and the reason
  // `CommandSpec.passthrough` exists: `x test unit -- --coverage --bail` parsed both flags and
  // dropped both, so a run that measured no coverage reported exactly what a coverage run does.
  passthrough: true,
  flags: [
    {
      name: 'workers',
      type: 'string',
      summary: `bun worker count (default: ${WORKER_OVERSUBSCRIBE}x CPUs, min ${WORKER_FLOOR}, max ${WORKER_CEILING}); clamped to the file count, and to 1 for ${SERIAL_TYPES.join(' and ')}`,
    },
    {
      name: 'worker',
      type: 'string',
      summary:
        'run only shard I of an N-way split of the selection, serially — one CI job\u2019s share',
    },
    { name: 'filter', type: 'string', summary: 'only files whose path contains this substring' },
    {
      name: 'sample',
      type: 'string',
      summary:
        'run at most N files of the selected type — a fast signal for the eval loop, never a gate',
    },
    {
      name: 'affected',
      type: 'boolean',
      summary: 'only the workspaces a diff touches, and everything that depends on one of them',
    },
    {
      name: 'base',
      type: 'string',
      summary: `--affected: git ref to diff against, merge-base style (default: ${DEFAULT_BASE})`,
    },
    {
      name: 'dirty',
      type: 'boolean',
      summary: '--affected: also count uncommitted work, whichever agent in this checkout made it',
    },
  ],
};
