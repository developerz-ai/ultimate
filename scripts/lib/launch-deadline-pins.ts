// The ratchet under `scripts/launch-deadline.ts`: how many of each package's tests await a browser
// launch under a deadline of their own — a literal, or Bun's 5 s default — instead of the launch's
// designed budget (`launchTestMs`, `LAUNCH_TEST_MS`, `E2E_BROWSER_OPEN_MS`). The number may FALL
// and may never rise. Data only — the gate owns what it does with these.

/** Where the table lives, so a stale-pin finding can name the file to edit. */
export const PINS_FILE = 'scripts/lib/launch-deadline-pins.ts';

//
// As of 2026-11-15 (plan 101b sweep 7): the first scan found 31 — scraping 28, testing 2, cli 1.
// All three now take `LAUNCH_TEST_MS`; the table starts empty.
//
// why: the ratchet is new and the tree is clean on its first day — no row to raise.

import type { PinTable } from './ratchet';

export const LAUNCH_DEADLINE_PINS: PinTable = {};
