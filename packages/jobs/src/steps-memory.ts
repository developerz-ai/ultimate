// The in-memory `StepStore`: what `createMemoryDriver` and every runner test persist steps into.
// Split from `steps.ts` at the file-size ceiling, along the seam the pg driver already draws —
// `driver-pg.ts` holds the Postgres store, this file the map-backed one, `steps.ts` the runner
// both are handed to. Same contract, and `steps.test.ts` is where the contract is pinned.

import type { StepRecord, StepStore } from './steps';

export function createMemoryStepStore(): StepStore {
  const byRun = new Map<string, Map<string, StepRecord>>();
  const runOf = (runId: string): Map<string, StepRecord> => {
    let run = byRun.get(runId);
    if (run === undefined) {
      run = new Map();
      byRun.set(runId, run);
    }
    return run;
  };
  return {
    get(runId, name) {
      return Promise.resolve(byRun.get(runId)?.get(name));
    },
    put(record) {
      runOf(record.runId).set(record.name, record);
      return Promise.resolve();
    },
    list(runId) {
      const records = [...(byRun.get(runId)?.values() ?? [])];
      return Promise.resolve(records.sort((a, b) => a.startedAt - b.startedAt));
    },
    del(runId, name) {
      byRun.get(runId)?.delete(name);
      return Promise.resolve();
    },
    clear(runId) {
      byRun.delete(runId);
      return Promise.resolve();
    },
  };
}
