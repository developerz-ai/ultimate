// The ratchet under `scripts/config-readers.ts`: the `AppConfig` leaf keys that no file in
// `packages/*/src` reads, each with the sentence saying why that is not a defect. The set may
// SHRINK and may never grow — a new dead key is a finding, not a row.
//
// A reason, not a boolean, deliberately: "pinned" with no sentence is a waiver, and the twelve keys
// this rule exists for (`jobs.driver`, `realtime.heartbeatMs`, `database.urlEnv/poolSize/schema`,
// `pwa.installPrompt`, `auth.afterSignInPath`, `ai.modelEnv`, …) would each have been waived by
// whoever added them. The sentence has to name a READER — a file, or a surface outside this repo —
// or, where there is none, the decision the key is waiting on. A sentence naming APP code is checked
// against both tracked apps (`config-app-readers.ts`, `X_CONFIG_READER_APP_UNREAD`).
//
// Shrink it with `bun run scripts/config-readers.ts --unpin <leaf>[,<leaf>]`, which drops a key
// whose reader has landed and refuses to drop one that still has none.

/** Where the table lives, so a stale-pin finding can name the file to edit. */
export const CONFIG_PINS_FILE = 'scripts/lib/config-reader-pins.ts';

/**
 * Measured 2026-08-22, on the first run: FIVE of thirty leaf keys, three of which are the
 * documented app-facing shape and two of which looked exactly like `database.urlEnv` did before
 * 5.0.0 deleted it. `cache.urlEnv` was one of the two and is now FOUR: it was deleted with
 * `cache.driver` in the same release that made `cache.tiers` build the ladder, which is the
 * decision the row was waiting for. `realtime.urlEnv` was the same defect and 22.0.0 spent it the
 * other way — by WIRING it: `@ultimat3/realtime`'s `selectTransport` dials the variable it names.
 */
export const CONFIG_READER_PINS: Readonly<Record<string, string>> = {
  defaultTimeZone:
    "read by NOTHING but `config.ts`'s own validator (`isIanaZoneName`): no package reads it (CLAUDE.md forbids an ambient time zone) and neither tracked app does — both only write it in app.config.ts. Delete-or-wire is an owner decision, plan 101 slice 15 row 6, asked and unanswered; this row is that debt.",
  defaultCurrency:
    "read by NOTHING but `config.ts`'s validator (`CURRENCY_RE`): `Money` carries its own currency, so no package defaults one, and neither tracked app reads it outside app.config.ts. Same owner decision as `defaultTimeZone`, plan 101 slice 15 row 6.",
};

/**
 * The SECOND table: leaf keys whose "readers" are a bare-name collision and not evidence at all.
 *
 * Separate from the one above because the two record different facts. A `CONFIG_READER_PINS` row
 * says "nothing under `packages/<pkg>/src` reads this, and here is who does". A row here says "this
 * cannot tell whether anything reads it, and here is why that is tolerated today". Merging them
 * would let the weaker claim wear the stronger one's sentence.
 *
 * Measured 2026-08-23, on the first run of `ambiguityOf`: FOUR of twenty-eight leaf keys, and all
 * four are the same shape — a bare name common enough to match ten or more files, not one of them
 * inside the section's own package, and no file anywhere spelling the qualified `<section>.<key>`.
 * Every other leaf key in the tree has at least one bare match inside its own package.
 *
 * Every one of these is a `jobs.driver` candidate, not a cleared key. Each row says what would
 * settle it, and settling one is deleting the row.
 */
export const CONFIG_AMBIGUOUS_PINS: Readonly<Record<string, string>> = {};

/**
 * What this leaf is excused for today, or `undefined`. Absent means the doubt is a finding — and so
 * does a row whose reason is BLANK: "pinned" with no sentence is the waiver this file's own header
 * refuses, and the trim guard is what makes that sentence enforced rather than stated.
 */
export const configReaderPinnedFor = (
  leaf: string,
  pins: Readonly<Record<string, string>> = CONFIG_READER_PINS,
): string | undefined =>
  Object.hasOwn(pins, leaf) && (pins[leaf] ?? '').trim() !== '' ? pins[leaf] : undefined;

/** The same question of the second table. Called by `checkConfigReaders`, and by nobody before. */
export const configAmbiguityPinnedFor = (
  leaf: string,
  pins: Readonly<Record<string, string>> = CONFIG_AMBIGUOUS_PINS,
): string | undefined =>
  Object.hasOwn(pins, leaf) && (pins[leaf] ?? '').trim() !== '' ? pins[leaf] : undefined;

/**
 * The edit `X_CONFIG_READER_PIN_STALE` names, performed: drop each named key whose reader has
 * landed, and refuse to drop one that is still read by nobody. Returns the entries it changed, so
 * the caller can say "nothing to drop" rather than reporting a write it did not make.
 */
export async function applyConfigReaderUnpin(
  root: string,
  leaves: readonly string[],
  gaps: readonly { readonly kind: string; readonly leaf: string }[],
): Promise<readonly string[]> {
  const stale = new Set(gaps.filter((gap) => gap.kind === 'stale').map((gap) => gap.leaf));
  const path = `${root}/${CONFIG_PINS_FILE}`;
  let text = await Bun.file(path).text();
  const dropped: string[] = [];
  for (const leaf of leaves) {
    if (!stale.has(leaf)) continue;
    // The entry spans from its key line to the line before the next key or the closing brace —
    // Biome wraps a long reason across several lines, so a one-line delete would leave the tail.
    // `RegExp.escape`, never a single `.replace('.', …)`: that form replaces the FIRST dot only,
    // so `ai.mcp.path` reached the pattern with its second dot live and matched a neighbouring row.
    const entry = new RegExp(
      `^\\s*'?${RegExp.escape(leaf)}'?:[\\s\\S]*?,\\n(?=\\s*(?:'|\\w|\\}))`,
      'm',
    );
    if (!entry.test(text)) continue;
    text = text.replace(entry, '');
    dropped.push(leaf);
  }
  if (dropped.length > 0) await Bun.write(path, text);
  return dropped;
}
