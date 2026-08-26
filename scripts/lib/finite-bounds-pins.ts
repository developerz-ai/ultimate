// The ratchet under `scripts/finite-bounds.ts`: how many numeric options each package defaults
// with `??` and never checks for finiteness. The number may FALL and may never rise. Data only.
//
// WHY A COUNT AND A SENTENCE. Every site pinned here is a claim that the number cannot arrive as
// `NaN` or `±Infinity` — which holds exactly until it comes from `Number(process.env.X)`, a
// `parseInt`, a JSON body or an untyped config file. The sentence is where a human says which side
// of that line the package's options sit on, and says so out loud when the answer is "nobody has
// looked yet". A pin with no sentence is a debt nobody can pay, because nobody knows what it is.
//
// Shrink it with `bun run scripts/finite-bounds.ts --unpin <pkg>[,<pkg>]`, which lowers a count to
// what is measured and refuses to raise one. Raising a count is a hand edit, in a review.

/** Where the table lives, so a stale-pin finding can name the file to edit. */
export const FINITE_BOUNDS_PINS_FILE = 'scripts/lib/finite-bounds-pins.ts';

export interface FiniteBoundPin {
  readonly count: number;
  readonly reason: string;
}

/**
 * Measured against a tree in which **tiers 0 through 3** are repaired — the first two slices of the
 * 17.0.0 sweep. A repaired package is ABSENT from this table rather than pinned at zero, and that
 * absence is the machine-checkable claim that its slice closed all of it: `core`, `schema`, `db`,
 * `cache`, `storage`, `time`, `money`, `i18n`, `seo`, `flags` (tier 0–1, 2026-08-26), then `entity`,
 * `policy`, `http`, `auth`, `action`, `query`, `jobs`, `realtime` (tier 2–3). 129 sites → 59.
 *
 * What remains is tier 4 and tier 5, and every count below FALLS as those land. That is the ratchet
 * working, not drift: `X_FINITE_BOUND_PIN_STALE` fires the moment a slice repairs a package and
 * leaves its row behind, so each slice is forced to lower its own rows in the same commit.
 * `scripts/finite-bounds.test.ts` holds the other half — it names every swept package, and a name
 * may only ever be added there.
 *
 * The class was found by hand three times in one day before this file existed: `@ultimat3/ai`'s
 * `chunk({ size: NaN })` (a SYNCHRONOUS infinite loop, past every `AbortSignal`, past the job
 * timeout, on the worker's only thread) and `hive({ concurrency: NaN })` (`Array.from({ length:
 * NaN })` is `[]`, so zero workers ran and the result reported clean success over an array of
 * holes), then six more across `jobs` and `realtime`. That is the same three-strikes bar
 * `config-readers`, `proto-index`, `flight-copies` and `sql-literal-copies` were each written at.
 */
export const FINITE_BOUNDS_PINS: Readonly<Record<string, FiniteBoundPin>> = {
  admin: {
    count: 4,
    reason:
      '`audit.ts`, `layout.tsx`, `resource.ts`, `search.ts` — `capacity`, `limitPerResource`, `pageSize`, `width`. NOT AUDITED — this count falls when the tier 5 slice of the 17.0.0 sweep lands.',
  },
  cli: {
    count: 6,
    reason:
      '`dev-traces.ts`, `e2e-page.ts`, `island-shot.ts`, `metrics-endpoint.ts`, `sync-authenticator.ts` — `limit`, `minBytes`, `port`, `serviceWorkerTimeoutMs`, `timeoutMs`, `ttlMs`, …. NOT AUDITED — this count falls when the tier 5 slice of the 17.0.0 sweep lands.',
  },
  scraping: {
    count: 9,
    reason:
      '`actionability.ts`, `driver-fake.ts`, `expect.ts`, `http.ts`, `robots-fetch.ts` and more — `graceMs`, `idleMs`, `maxBytes`, `pollMs`, `rate`, `timeoutMs`, …. NOT AUDITED — this count falls when the tier 5 slice of the 17.0.0 sweep lands.',
  },
  testing: {
    count: 1,
    reason:
      '`determinism.ts` — `seed`. NOT AUDITED — this count falls when the tier 5 slice of the 17.0.0 sweep lands.',
  },
  ui: {
    count: 3,
    reason:
      '`Combobox.tsx`, `Section.tsx`, `Textarea.tsx` — `debounceMs`, `level`, `rows`. AUDITED in the tier 4 slice of the 17.0.0 sweep, and left on purpose. `debounceMs` and `level` are screened ONE HOP AWAY, which this rule cannot see (its own blind spot 3): `debounce()` throws `X_UI_INVALID_VALUE` for a non-finite delay and `headingTag()` throws it for a level off the 1-6 scale, so a second screen at the prop would give one value two codes. `rows` is the only genuinely unscreened one, and it is the only prop of the four whose bad value produces neither silent zero-work nor a throw: a `rows` attribute the HTML parser rejects falls back to the element default, a two-row box instead of three, so there is no unbounded read and no crash — and throwing an X_INVARIANT out of a render would blank a whole form over a cosmetic typo. `layout.test.ts` and `file-controls.test.ts` hold the evidence for the first two. Overturn `rows` with one `finiteCount("Textarea", "rows", props.rows ?? 3, 1)` at Textarea.tsx:42.',
  },
};

/** What this package is allowed to have today. Absent means zero, deliberately. */
export const finiteBoundsPinnedFor = (
  pkg: string,
  pins: Readonly<Record<string, FiniteBoundPin>> = FINITE_BOUNDS_PINS,
): number => (Object.hasOwn(pins, pkg) ? (pins[pkg]?.count ?? 0) : 0);

/**
 * The edit `X_FINITE_BOUND_PIN_STALE` names, performed: lower each named package's count to what is
 * measured, and refuse to raise one. Returns the entries it changed.
 */
export async function applyFiniteBoundsUnpin(
  root: string,
  packages: readonly string[],
  counts: Readonly<Record<string, number>>,
  pins: Readonly<Record<string, FiniteBoundPin>> = FINITE_BOUNDS_PINS,
): Promise<readonly string[]> {
  const path = `${root}/${FINITE_BOUNDS_PINS_FILE}`;
  let text = await Bun.file(path).text();
  const written: string[] = [];
  for (const pkg of packages) {
    const found = counts[pkg] ?? 0;
    if (found >= finiteBoundsPinnedFor(pkg, pins)) continue;
    // `RegExp.escape`, never the raw key: a name holding regex syntax matches a NEIGHBOURING row.
    const key = RegExp.escape(pkg);
    if (found === 0) {
      // The whole entry, reason and all — a row claiming a debt of zero reads as a rule still in
      // force over nothing. Both spellings Biome writes: one line, and the wrapped form.
      const entry = new RegExp(`^\\s*(['"]?)${key}\\1:\\s*\\{[\\s\\S]*?\\},\\n`, 'm');
      if (!entry.test(text)) continue;
      text = text.replace(entry, '');
    } else {
      const entry = new RegExp(`^(\\s*(['"]?)${key}\\2:\\s*\\{\\s*\\n?\\s*count:\\s*)\\d+,`, 'm');
      if (!entry.test(text)) continue;
      text = text.replace(entry, `$1${String(found)},`);
    }
    written.push(`${pkg} -> ${String(found)}`);
  }
  if (written.length > 0) await Bun.write(path, text);
  return written;
}
