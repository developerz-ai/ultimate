// What one runner's step kinds share: the hydrated view, the fenced write, the name claim and the
// unwind check. `steps.ts` builds it; `steps-wait.ts` and `steps-unwind.ts` read it. Internal —
// never re-exported: a body sees `StepApi`, and `executeJob` sees `StepRunner`.

import type { EventLookup } from './steps-api';
import type { StepRecord } from './steps-store';

export interface RunnerCore {
  readonly runId: string;
  readonly jobName: string;
  readonly events: EventLookup | undefined;
  /** The backstop a waiting step parks for between polls. */
  readonly pollMs: number;
  /** Claims a body's step name: a reserved one or a second use is refused here. */
  claim(name: string): void;
  load(name: string): Promise<StepRecord | undefined>;
  /** EVERY write, fenced and refused once the attempt is cancelled. */
  put(record: StepRecord): Promise<void>;
  now(): number;
  replayed(name: string): void;
  /**
   * Throws `UnwindReached` when the run is unwinding. Every step calls it after its replay check
   * and before doing work: in unwind mode the forward path ends at the first incomplete step.
   */
  forwardOnly(name: string): Promise<void>;
}
