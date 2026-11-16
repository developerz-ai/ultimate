// The ratchet under `scripts/port-probe.ts`: how many ports each package's tests, fixtures and
// scripts take by probing — bind 0, release, hand the number on — instead of binding them. The
// number may FALL and may never rise. Data only — the rule owns what it does with these.
//
// Shrink it with `bun run scripts/port-probe.ts --unpin <pkg>[,<pkg>]`, which lowers a count to
// what is measured and refuses to raise one. Raising a count is a hand edit, in a review.

/** Where the table lives, so a stale-pin finding can name the file to edit. */
export const PORT_PROBE_PINS_FILE = 'scripts/lib/port-probe-pins.ts';

/**
 * Measured 2026-11-15, on the rule's first run, after every probe under `packages/` moved onto
 * `bindFreePorts`, a held listener, or port 1 for a dial that must be refused.
 */
export const PORT_PROBE_PINS: Readonly<Record<string, number>> = {
  // why: the rule is new — `scripts/bench/boot-large-app-proc.test.ts` (its own `freePort`, a probe
  // whose number goes into a child's source) and `scripts/scaffold-admin.ts` (`freeDevPair` over
  // `freePortPair`, handed to a scaffolded app's `x dev`) were outside the sweep that wrote it.
  scripts: 5,
};
