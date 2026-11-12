// Single responsibility: the production `Scheduler` behind every shutdown wait of the replication
// path — the replicator's restart timer and the stream's drain deadline. Unref'd: a pending wait
// must never be what keeps a draining process alive. Tests inject their own.

import type { Scheduler } from './thundering-herd';

export const unrefScheduler: Scheduler = (fn, ms) => {
  const handle = setTimeout(fn, ms);
  handle.unref?.();
  return () => {
    clearTimeout(handle);
  };
};
