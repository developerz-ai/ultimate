// The failures of the machine memory ledger. Admission is a courtesy between processes, so the two
// environment failures are reported and the work goes ahead; only `x heavy run` refuses anything.

import { UltimateError } from '@ultimat3/core';
import { HEAVY_MEMORY_ENV } from './heavy-env';
import { quoteArg } from './shell-quote';

export class HeavyLedgerUnavailableError extends UltimateError {
  constructor(reason: string) {
    super({
      code: 'X_HEAVY_LEDGER_UNAVAILABLE',
      cause: `the machine memory ledger cannot be used: ${reason}; this run continues unadmitted`,
      fix: 'x heavy status --json',
    });
  }
}

export class HeavyMemoryInvalidError extends UltimateError {
  constructor(raw: string) {
    super({
      code: 'X_HEAVY_MEMORY_INVALID',
      cause: `${HEAVY_MEMORY_ENV}=${JSON.stringify(raw)} is not a byte size`,
      fix: 'export ULTIMATE_HEAVY_MEMORY=8g   # or 0 to turn the ledger off',
    });
  }
}

export class HeavyCommandNotFoundError extends UltimateError {
  constructor(command: string) {
    super({
      code: 'X_HEAVY_COMMAND_NOT_FOUND',
      cause: `${JSON.stringify(command)} is not an executable on PATH`,
      fix: `bun --print ${quoteArg(`Bun.which(${JSON.stringify(command)})`)}   # null: install it or correct the name, then: x heavy run -- <command>`,
    });
  }
}
