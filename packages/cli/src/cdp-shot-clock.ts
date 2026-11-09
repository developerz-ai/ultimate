// The page deadline a shot run uses when it names none. The clock a session runs on is core's
// `SleepClock` — `systemClock` in a run, a `frozenClock` under test, where sleeping IS advancing,
// so a 30-second deadline finishes in microseconds (v31: `ShotClock` was that interface renamed).

/** A navigation or a wait with no `timeout` of its own gets this. */
export const DEFAULT_PAGE_TIMEOUT_MS = 30_000;
