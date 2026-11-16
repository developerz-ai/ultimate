// The ratchet under `scripts/port-probe.ts`: how many ports each package's tests, fixtures and
// scripts take by probing — bind 0, release, hand the number on — instead of binding them. The
// number may FALL and may never rise. Data only — the rule owns what it does with these.
//
// Shrink it with `bun run scripts/port-probe.ts --unpin <pkg>[,<pkg>]`, which lowers a count to
// what is measured and refuses to raise one. Raising a count is a hand edit, in a review.

/** Where the table lives, so a stale-pin finding can name the file to edit. */
export const PORT_PROBE_PINS_FILE = 'scripts/lib/port-probe-pins.ts';

/**
 * Empty since 2026-11-15 (sweep 7): every probe in the tree binds through `bindFreePorts`, holds its
 * listener, or dials port 1 where a refused connection is the subject. A package absent is zero.
 */
export const PORT_PROBE_PINS: Readonly<Record<string, number>> = {};
