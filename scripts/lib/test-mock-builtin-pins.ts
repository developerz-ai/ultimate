// The ratchet under `scripts/test-mock-builtin.ts`: how many of each package's tests replace a node
// builtin with `mock.module`. The number may FALL and may never rise. Data only — the gate owns
// what it does with these.
//
// As of 2026-11-15 (plan 101b sweep 7): the first scan found none, so the table starts empty and
// stays so — a mock of `node:fs` is process-global and leaks into the next file in one process.

/** Where the table lives, so a stale-pin finding can name the file to edit. */
export const PINS_FILE = 'scripts/lib/test-mock-builtin-pins.ts';

export const MOCK_BUILTIN_PINS: Readonly<Record<string, number>> = {};
