// The ratchet under `scripts/test-real-sleep.ts`: how many of each package's own TESTS wait for the
// wall clock (`Bun.sleep(n)`, `setTimeout(…, n > 1)`, `setInterval`) without a `// real-clock:`
// reason. The number may FALL and may never rise. Data only — the gate owns what it does with these.
//
// Measured 2026-10-30: 355 sites in 173 test files (340 in the gate's corpus), ~44 s of literal delays. The first sweep moved the
// realtime sweeps (`sync-presence`, `sync-drain`: 7.6 s of `Bun.sleep`) onto Bun's fake timers and
// marked two deadlines a pass never waits out. Much of what is left is a subject's own timers that
// fake timers will drive the same way, and e2e / `.live.` waits on another process, which take a
// `// real-clock:` reason on the line instead.
//
// Shrink it with `bun run scripts/test-real-sleep.ts --unpin <pkg>[,<pkg>]`, which lowers a count
// to what is measured and refuses to raise one. Raising a count is a hand edit, in a review.

/** Where the table lives, so a stale-pin finding can name the file to edit. */
export const PINS_FILE = 'scripts/lib/test-real-sleep-pins.ts';

export const REAL_SLEEP_PINS: Readonly<Record<string, number>> = {
  ai: 4,
  auth: 1,
  cache: 1,
  cli: 106,
  core: 18,
  db: 25,
  entity: 2,
  http: 10,
  jobs: 77,
  mail: 6,
  notify: 1,
  pwa: 6,
  realtime: 60,
  render: 7,
  scraping: 2,
  scripts: 4,
  testing: 7,
  ui: 3,
};
