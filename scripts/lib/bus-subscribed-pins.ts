// The ratchet under `scripts/bus-subscribed.ts`: how many publishes each package's LIVE tests send
// with no awaited subscription confirmation before them in the test (`subscribed()`, or an awaited
// `subscribe` the bus answers only once the server holds it). The number may FALL and may never
// rise. Data only — the gate owns what it does with these.
//
// As of 2026-11-15 (plan 101b sweep 7): the first scan found 7, all in realtime. Three now await
// `subscribed()` (a publish after a re-dial, a reconnect, a relay release); four carry
// `// bus-order:` — one lost by design, three ordered by an awaited subscribe the scan cannot see.
// The table is empty.

/** Where the table lives, so a stale-pin finding can name the file to edit. */
export const PINS_FILE = 'scripts/lib/bus-subscribed-pins.ts';

export const BUS_SUBSCRIBED_PINS: Readonly<Record<string, number>> = {};
