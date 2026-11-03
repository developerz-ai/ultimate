// Single responsibility: the timer every pool deadline arms. A deadline guards work in flight, so it
// must never be the thing keeping a finished process alive.

import type { Scheduler } from '@ultimat3/core';

export const unrefSchedule: Scheduler = (fn, ms) => {
  const timer = setTimeout(fn, ms);
  timer.unref?.();
  return () => clearTimeout(timer);
};
