// The ratchet under `scripts/version-stamps.ts`: the pages that name a version next to an `As of`
// date and are NOT stamping this tree. The set may SHRINK and may never grow — a new page stamping
// a version is a finding, not a row.
//
// WHY IT EXISTS. `STAMP` required a literal `v` and allowed only `[\s*_.]` between the number and
// the `` `As of ``, so it saw ZERO stamps in the two most-read files in the repo:
// `AGENTS.md` wrote `**3.0.0** in lockstep, \`As of 2026-08-19\`` and root `CLAUDE.md` wrote
// `**Status:** 7.0.0, released, \`As of 2026-08-21\``, both while the tree shipped a later major,
// and the rule printed `✓ 30 workspaces at 9.0.0`. One missing character defeated it.
//
// Widening the pattern is what makes those visible, and it also reaches four sentences that name a
// version for a reason that is not a stamp — a THIRD-PARTY version, or a PAST release the sentence
// is about. Each is pinned here with the sentence saying which, because "the regex is a bit loose"
// is the waiver axiom 3 refuses.
//
// KEYED BY PAGE AND VERSION, never by line: a line number drifts on every edit, and a pin on the
// PAGE alone would excuse a real stale stamp that lands beside the excused sentence. The pin says
// "this page may say 2.0.0 next to an `As of`", and nothing more.
//
// Shrink it with `bun run scripts/version-stamps.ts --unpin <page>@<version>`, which drops a pin
// whose sentence is gone and refuses to drop one still on the page.

/** Where the table lives, so a stale-pin finding can name the file to edit. */
export const STAMP_PINS_FILE = 'scripts/lib/version-stamp-pins.ts';

/** `<repo-relative page>@<version>` — the key the `fix:` line emits, so it can be pasted back. */
export const stampPinKey = (path: string, version: string): string => `${path}@${version}`;

/**
 * Measured 2026-08-23, on the first run of the widened pattern: four sentences, no stamps.
 * `AGENTS.md@3.0.0` is deliberately NOT here — that one is the defect the widening found.
 */
export const VERSION_STAMP_PINS: Readonly<Record<string, string>> = {
  'CLAUDE.md@2.0.0':
    'a claim about a PAST release — "of the four known gaps named in CHANGELOG.md, all four are closed in 2.0.0" — dated because the closure was, not because the tree ships 2.0.0.',
  'docs/idea/16-app-targets.md@2.10.1':
    "TAURI's version, not this framework's. The sentence dates when Tauri was surveyed, and no `@ultimat3/*` package has ever declared 2.10.1.",
  'wiki/Building-Your-Own-Base.md@4.0.0':
    'names the release the page\'s fenced examples were last COMPILED against ("Re-run against 4.0.0"). A verification date, not a version stamp — re-running it against a later major moves this row rather than deleting it.',
  'wiki/Upgrading.md@2.0.0':
    "names which major's entries joined the page and when. The page walks every major by design, so it names all of them; only this one lands within reach of the date.",
};

/** Whether a version named on a page is excused, and why. `undefined` means it is a stamp. */
export const stampPinnedFor = (
  path: string,
  version: string,
  pins: Readonly<Record<string, string>> = VERSION_STAMP_PINS,
): string | undefined => {
  const key = stampPinKey(path, version);
  return Object.hasOwn(pins, key) ? pins[key] : undefined;
};

/**
 * The edit `X_VERSION_STAMP_PIN_STALE` names, performed: drop each named pin whose sentence is no
 * longer on the page, and refuse to drop one that still is. Returns the entries it changed, so the
 * caller can say "nothing to drop" rather than reporting a write it did not make.
 */
export async function applyStampUnpin(
  root: string,
  keys: readonly string[],
  stale: readonly string[],
): Promise<readonly string[]> {
  const doomed = new Set(stale);
  const path = `${root}/${STAMP_PINS_FILE}`;
  let text = await Bun.file(path).text();
  const dropped: string[] = [];
  for (const key of keys) {
    if (!doomed.has(key)) continue;
    // The entry spans from its key line to the line before the next key or the closing brace —
    // Biome wraps a long reason across several lines, so a one-line delete leaves the tail behind.
    // `RegExp.escape` because a page path is full of `.` and `/`.
    const entry = new RegExp(
      `^\\s*'?${RegExp.escape(key)}'?:[\\s\\S]*?,\\n(?=\\s*(?:'|\\w|\\}))`,
      'm',
    );
    if (!entry.test(text)) continue;
    text = text.replace(entry, '');
    dropped.push(key);
  }
  if (dropped.length > 0) await Bun.write(path, text);
  return dropped;
}
