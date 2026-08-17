// Single responsibility: the PGlite driver fake the adapter tests record statements against.
// Shared rather than copied for the same reason `fake-reservable.ts` is: the assertion in every
// one of these tests is the recorded ORDER, and two copies of the recorder drift into two orders.

import type { PgliteDriver, PgliteResult } from './pglite';

/** One statement as the driver received it — the text after binding, and the bound values. */
export interface Recorded {
  readonly text: string;
  readonly values: readonly unknown[];
}

export type RecordingPgliteDriver = PgliteDriver & {
  readonly calls: Recorded[];
  closed: number;
};

/** A driver that answers every statement with `result` and remembers the order it saw them in. */
export function fakeDriver(result: PgliteResult): RecordingPgliteDriver {
  const calls: Recorded[] = [];
  return {
    calls,
    closed: 0,
    async query(text, values) {
      calls.push({ text, values: values ?? [] });
      return result;
    },
    async close() {
      this.closed += 1;
    },
  };
}
