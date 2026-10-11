// Single responsibility: one condition that KEEPS failing, said rarely — on failures 1, 2, 4, 8, …
// and once more when it ends. An outage is one fact; a line per retry per pod for as long as it
// lasts is the fact buried under itself.

import { type LogFields, logger } from './logger';

export interface OutageLogOptions {
  /** The line's message while the condition fails. Low cardinality: it is what a monitor groups on. */
  readonly event: string;
  /**
   * `'warn'` for a process that is degraded and still serving (a publisher without its bus).
   * `'error'` for one that cannot do its job (a `sync` node without its bus).
   */
  readonly level: 'warn' | 'error';
}

export interface OutageLog {
  /**
   * One more failure. Written — with `failures`, the count since it last worked — on the 1st,
   * 2nd, 4th, 8th, …; answers whether this one was, so a caller thins a second sink the same way.
   */
  failed(fields?: LogFields): boolean;
  /** It works again: ONE `info` line, `<event> recovered`, with `after`. Silent when nothing had failed. */
  recovered(fields?: LogFields): void;
  /** Failures since it last worked. */
  readonly failures: number;
}

/** True on 1, 2, 4, 8, …: the attempts an outage is said on. */
export function isOutageMilestone(failures: number): boolean {
  return failures > 0 && (failures & (failures - 1)) === 0;
}

export function outageLog(options: OutageLogOptions): OutageLog {
  let failures = 0;
  return {
    get failures(): number {
      return failures;
    },
    failed(fields?: LogFields): boolean {
      failures += 1;
      if (!isOutageMilestone(failures)) return false;
      logger[options.level](options.event, { ...fields, failures });
      return true;
    },
    recovered(fields?: LogFields): void {
      if (failures === 0) return;
      const after = failures;
      failures = 0;
      logger.info(`${options.event} recovered`, { ...fields, after });
    },
  };
}
