// The ratchet under `scripts/test-fix-citations.ts`: how many `fix:` lines each package's own
// TESTS write or assert that cite a command this build cannot run. The number may FALL and may
// never rise. Data only — the gate owns what it does with these.
//
// Measured 2026-08-19 over 30 packages: 8 unrunnable, in 4 packages. Every one is a
// FIXTURE rather than a shipped error — `checkErrorFixes` already holds `src/` to this rule and
// finds nothing — so what is pinned here is a test teaching a reader a command that does not
// exist, which is the shape the two that DID ship (`x schema show`, `x logs tail`) were copied
// from. The seven in `packages/cli/src/error-contract.test.ts` are absent on purpose: they sit
// inside a string that test writes to disk, and the scanner does not read a nested literal as this
// file's own value.
//
// | Where | What it cites | Why it is still here |
// |---|---|---|
// | `packages/ai/src/tools.test.ts` | `x db query "select …"` | a flattened-error fixture; `x db` has no `query` |
// | `packages/core/src/errors.test.ts` | `x storage use local` | `notImplemented`'s pass-through, asserted with an arbitrary string |
// | `packages/flags/src/runtime.test.ts` | `x flags --json` | a helper that builds one `UltimateError` for the reporter tests |
// | `packages/http/src/overlay.test.ts` | `x db preload`, `x db batch` | the dev overlay's N+1 and batch notice fixtures, three lines |
// | `packages/http/src/pipeline.app.test.ts` | `x logs tail` | a fixture app handler, twice, citing the exact command that shipped broken before |
//
// Each is a one-line edit in a package this gate's author does not own; lowering a pin is what
// landing one looks like. Shrink it with
// `bun run scripts/test-fix-citations.ts --unpin <pkg>[,<pkg>]`, which lowers a count to what is
// measured and refuses to raise one. Raising a count is a hand edit, in a review.

/** Where the table lives, so a stale-pin finding can name the file to edit. */
export const PINS_FILE = 'scripts/lib/test-fix-pins.ts';

export const TEST_FIX_PINS: Readonly<Record<string, number>> = {
  ai: 1,
  core: 1,
  flags: 1,
  http: 5,
};
