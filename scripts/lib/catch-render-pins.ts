// The ratchet under `scripts/catch-render.ts`: how many of each package's `catch` blocks render the
// caught value into a `cause:` / `fix:` / `detail:` through `instanceof`, `String()`,
// `JSON.stringify()` or a bare `${…}`. The number may FALL and may never rise. Data only.
//
// Measured on the first run of the rule, under a green `errors` step — which is the argument for
// the rule: `scripts/error-render.ts` reads PARAMETERS annotated `unknown`, and a catch binding is
// annotated by nobody, so it was green before and after a seven-site fix in `@ultimat3/ai` and
// `@ultimat3/mail`. Fifteen sites across five packages were then found by reading.
//
// The replacement is one import: `renderThrowable(error)` from `@ultimat3/core`, which is the
// framework's own total form and exists for exactly this — its doc names the seven places that
// spelled `error instanceof Error ? error.message : …` by hand.
//
// Shrink it with `bun run scripts/catch-render.ts --unpin <pkg>[,<pkg>]`, which lowers a count to
// what is measured and refuses to raise one. Raising a count is a hand edit, in a review.

/** Where the table lives, so a stale-pin finding can name the file to edit. */
export const CATCH_PINS_FILE = 'scripts/lib/catch-render-pins.ts';

/**
 * Day one, 2026-08-22: TWO sites, both of which the rule beside it read and had no opinion about.
 *
 *   `packages/realtime/src/pgoutput.ts:95` — `detail: \`… ${String(cause)}\``, where `cause` is the
 *   catch binding of a `JSON.parse` on a value that came off the wire.
 *   `scripts/verify.ts:114` — `cause: \`… ${error instanceof Error ? error.message : String(error)}\``,
 *   the exact shape `renderThrowable` was hoisted to delete.
 *
 * Two rather than fifteen because this sweep had already fixed the other thirteen BY HAND. That is
 * the argument for pinning at all: the class emptied without a gate, so nothing stops it refilling.
 *
 * `scripts` is already gone, LOWERED THE SAME DAY by `--unpin scripts` after `verify.ts:114` was
 * repaired an hour later — which is the ratchet's other direction working on its first afternoon:
 * a pin above what the tree contains is a finding, not tidy housekeeping somebody gets to.
 */
export const CATCH_RENDER_PINS: Readonly<Record<string, number>> = {};

/** What this package is allowed to have today. Absent means zero, deliberately. */
export const catchRenderPinnedFor = (
  pkg: string,
  pins: Readonly<Record<string, number>> = CATCH_RENDER_PINS,
): number => pins[pkg] ?? 0;

/**
 * The edit `X_CATCH_RENDER_PIN_STALE` names, performed: lower each named package's pin to what is
 * measured, and refuse to raise one. Returns the entries it changed, so the caller can say
 * "nothing to lower" rather than reporting a write it did not make.
 */
export async function applyCatchRenderUnpin(
  root: string,
  packages: readonly string[],
  counts: Readonly<Record<string, number>>,
  // The table to compare against, which is the one in the file being EDITED. A default of the
  // imported constant would be right in production and wrong everywhere else: `root` may be a
  // temp directory, and comparing a fixture's rows against this module's would refuse an edit the
  // fixture needs — which is exactly how this function's own test first failed.
  pins: Readonly<Record<string, number>> = CATCH_RENDER_PINS,
): Promise<readonly string[]> {
  const path = `${root}/${CATCH_PINS_FILE}`;
  let text = await Bun.file(path).text();
  const written: string[] = [];
  for (const pkg of packages) {
    const found = counts[pkg] ?? 0;
    const pinned = catchRenderPinnedFor(pkg, pins);
    if (found >= pinned) continue;
    const entry = new RegExp(`^(\\s*)${pkg}: \\d+,$`, 'm');
    if (!entry.test(text)) continue;
    text =
      found === 0
        ? text.replace(new RegExp(`^\\s*${pkg}: \\d+,\\n`, 'm'), '')
        : text.replace(entry, `$1${pkg}: ${String(found)},`);
    written.push(`${pkg} -> ${String(found)}`);
  }
  if (written.length > 0) await Bun.write(path, text);
  return written;
}
