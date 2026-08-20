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

/** What this package is allowed to have today. Absent means zero, deliberately. */
export const testFixPinnedFor = (
  pkg: string,
  pins: Readonly<Record<string, number>> = TEST_FIX_PINS,
): number => pins[pkg] ?? 0;

/**
 * The edit `X_TEST_FIX_PIN_STALE` names, performed: lower each named package's pin to what is
 * measured, and refuse to raise one. Returns the entries it changed, so the caller can say
 * "nothing to lower" rather than reporting a write it did not make.
 */
export async function applyTestFixUnpin(
  root: string,
  packages: readonly string[],
  gaps: readonly { readonly kind: string; readonly pkg: string; readonly found: number }[],
): Promise<readonly string[]> {
  const path = `${root}/${PINS_FILE}`;
  let text = await Bun.file(path).text();
  const written: string[] = [];
  for (const pkg of packages) {
    const gap = gaps.find((one) => one.pkg === pkg && one.kind === 'stale');
    if (gap === undefined) continue;
    const entry = new RegExp(`^(\\s*)${pkg}: \\d+,$`, 'm');
    if (!entry.test(text)) continue;
    text =
      gap.found === 0
        ? text.replace(new RegExp(`^\\s*${pkg}: \\d+,\\n`, 'm'), '')
        : text.replace(entry, `$1${pkg}: ${String(gap.found)},`);
    written.push(`${pkg} -> ${String(gap.found)}`);
  }
  if (written.length > 0) await Bun.write(path, text);
  return written;
}
