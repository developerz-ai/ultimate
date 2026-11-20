// A refusal's fix sets a variable: pasted into a shell it must reach the process started from it,
// so each assignment is an `export`, never a shell-local `KEY=value` that exits 0 and changes nothing.

import { describe, expect, test } from 'bun:test';
import {
  PROCESSES_ENV,
  ProcessesInvalidError,
  ProcessesOverPoolError,
  ProcessesRoleSingletonError,
  ProcessesUnbalancedError,
  ProcessesUnsharedStateError,
} from './supervise-errors';

describe('unit · the processes refusals', () => {
  test('every fix that sets a variable exports it', () => {
    const errors = [
      new ProcessesInvalidError('two'),
      new ProcessesRoleSingletonError({ role: 'scheduler', requested: 2 }),
      new ProcessesUnsharedStateError({ requested: 2, reasons: ['the embedded database'] }),
      new ProcessesOverPoolError({ requested: 4, pool: 2 }),
      new ProcessesUnbalancedError({ requested: 2, platform: 'darwin' }),
    ];
    for (const error of errors) expect(error.fix).toMatch(/^export [A-Z_]+=\S/);
    const spelled = errors.filter((error) => !(error instanceof ProcessesOverPoolError));
    for (const error of spelled) expect(error.fix).toStartWith(`export ${PROCESSES_ENV}=`);
  });
});
