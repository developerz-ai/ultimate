// The failures of the machine memory ledger. Admission is a courtesy between processes, so the two
// environment failures are reported and the work goes ahead; only `x heavy run` refuses anything.

import { UltimateError } from '@ultimat3/core';
import { HEAVY_MEMORY_ENV } from './heavy-env';
import type { LedgerWait } from './heavy-ledger';
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

/** `--max-wait` ran out in the queue. The one refusal admission makes, and only when asked to. */
export class HeavyWaitExpiredError extends UltimateError {
  constructor(input: {
    readonly label: string;
    readonly maxWaitMs: number;
    readonly wait: LedgerWait;
  }) {
    const { wait } = input;
    const holders = wait.holds.map((entry) => entry.label).join(', ') || 'an admission in progress';
    super({
      code: 'X_HEAVY_WAIT_EXPIRED',
      cause: `${JSON.stringify(input.label)} was not admitted within --max-wait ${String(input.maxWaitMs / 1000)}s and did not start: it needs ${String(wait.needMb)} MB, was ${String(wait.position)} of ${String(wait.queued)} in the queue, and ${String(wait.usedMb)} of ${String(wait.capacityMb)} MB are held by ${holders}${wait.cpu === undefined ? '' : ', and the CPU was saturated'}; run it again later or with a longer --max-wait`,
      fix: 'x heavy status --json',
    });
  }
}
