// The ratchet under `scripts/gate-codes.ts`: every code the "never ships to an app" parenthesis in
// `wiki/Error-Codes.md` is wrong about TODAY. The list may shrink and may never grow.
//
// Two ways to be wrong, and both were already true when the rule shipped, which is why this is a
// ratchet rather than a red gate. NO_ROW is a code the parenthesis names and the page gives no
// table row — documented by parenthesis only, so an agent handed it finds a sentence naming it and
// nothing saying what to do. UNLISTED is a code `scripts/` declares that the parenthesis omits,
// which makes the sentence around it false: it promises every code above `## Reserved codes`
// resolves through `x errors explain` EXCEPT the ones it names, and these resolve through nothing.
//
// Why pinned and not derived: `wiki/Error-Codes.md` belongs to the docs surface and a rule that
// reds 26 rows the day it lands is a rule somebody turns off. Deleting an entry here and writing
// the row is always the better edit — `bun run scripts/gate-codes.ts --json` prints what to write.
//
// **Both lists are empty `As of 2026-08`.** All 26 were drained the way the file asks: 20 rows
// written from the declaring script, and 6 codes added to the parenthesis. An empty ratchet is the
// rule enforcing outright — the next gap reds the gate rather than joining a list.

/** Named in the parenthesis, no table row on the page. Drain by writing the row. */
export const GATE_CODE_NO_ROW: readonly string[] = [];

/** Declared under `scripts/`, absent from the parenthesis. Drain by adding the code to the list. */
export const GATE_CODE_UNLISTED: readonly string[] = [];
