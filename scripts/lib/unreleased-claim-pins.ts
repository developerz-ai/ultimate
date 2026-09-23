// The ratchet under `changelog-check`'s unreleased-claim rule: how many lines on each current page
// still call a DATED version "unreleased". A count may fall and may never rise; a count above what
// is measured is `X_DOC_UNRELEASED_PIN_STALE`, so the sweep and the pin land in one commit.
//
// why: measured 2026-09-23, the day 21.0.0 was dated — 33 lines on 17 pages, every one written the
// day before and true then. Plan 101 slice 17 swept them the same day, and this table holds what
// is left. Data only — `pin-raises` reads it like every other `*-pins.ts`.

/** Where the table lives, so a stale-pin finding can name the file to edit. */
export const UNRELEASED_PINS_FILE = 'scripts/lib/unreleased-claim-pins.ts';

export const UNRELEASED_CLAIM_PINS: Readonly<Record<string, number>> = {};
