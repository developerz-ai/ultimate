// The ratchet under `scripts/dead-docs-host.ts`: how many string literals in each package still
// build a URL on `ultimate.dev`. The number may FALL and may never rise. Data only.
//
// **Empty, and measured empty on the day the rule landed.** The sweep that deleted
// `ERROR_DOCS_BASE` / `errorDocsUrl(code)` from `@ultimat3/core` and the ~90 `docs:` lines under it
// finished first, so this table starts at zero and the rule enforces outright rather than
// ratcheting down. Twelve files still NAME the host, every one of them in a comment saying it was
// removed — a comment cannot 404, and the rule only reads string literals.
//
// An empty ratchet is the strongest state this shape has: the next occurrence reds the gate rather
// than joining a list. Adding a row here is a hand edit, in a review, and the review question is
// "why is a 404 acceptable in the line an operator reads when their build just failed".
//
// Shrink it with `bun run scripts/dead-docs-host.ts --unpin <pkg>[,<pkg>]`, which lowers a count to
// what is measured and refuses to raise one.

/** Where the table lives, so a stale-pin finding can name the file to edit. */
export const DEAD_HOST_PINS_FILE = 'scripts/lib/dead-docs-host-pins.ts';

export const DEAD_HOST_PINS: Readonly<Record<string, number>> = {};

/** What this package is allowed to have today. Absent means zero, deliberately. */
export const deadHostPinnedFor = (
  pkg: string,
  pins: Readonly<Record<string, number>> = DEAD_HOST_PINS,
): number => (Object.hasOwn(pins, pkg) ? (pins[pkg] ?? 0) : 0);

/**
 * The edit `X_DEAD_DOCS_HOST_PIN_STALE` names, performed: lower each named package's count to what
 * is measured, and refuse to raise one. Returns the entries it changed, so the caller can say
 * "nothing to lower" rather than reporting a write it did not make.
 */
export async function applyDeadHostUnpin(
  root: string,
  packages: readonly string[],
  counts: Readonly<Record<string, number>>,
  pins: Readonly<Record<string, number>> = DEAD_HOST_PINS,
): Promise<readonly string[]> {
  const path = `${root}/${DEAD_HOST_PINS_FILE}`;
  let text = await Bun.file(path).text();
  const written: string[] = [];
  for (const pkg of packages) {
    const found = counts[pkg] ?? 0;
    if (found >= deadHostPinnedFor(pkg, pins)) continue;
    // `RegExp.escape`, never the raw key: a name holding regex syntax matches a NEIGHBOURING row.
    const spelt = `(['"]?${RegExp.escape(pkg)}['"]?)`;
    const entry = new RegExp(`^(\\s*)${spelt}: \\d+,$`, 'm');
    if (!entry.test(text)) continue;
    text =
      found === 0
        ? text.replace(new RegExp(`^\\s*${spelt}: \\d+,\\n`, 'm'), '')
        : text.replace(entry, `$1$2: ${String(found)},`);
    written.push(`${pkg} -> ${String(found)}`);
  }
  if (written.length > 0) await Bun.write(path, text);
  return written;
}
