// The import-boundary table from the build contract, as data. A package may import only from a
// STRICTLY LOWER tier — never sideways within its own tier unless listed here, never upward.
// This is axiom 3: a convention that is not a build error does not exist.

// The contract's table is the first name in each row; `db`, `storage`, `auth` and `mail` are
// packages the repo grew afterwards, placed at the lowest tier their real imports allow (checked
// by this file's own rule, not by opinion). Adding a package here is a deliberate act: an import
// of a package that is not listed is a build error, never a shrug.
export const TIERS: Readonly<Record<number, readonly string[]>> = {
  0: ['core', 'schema'],
  1: ['i18n', 'money', 'time', 'cache', 'seo', 'db', 'storage', 'flags'],
  2: ['entity', 'policy', 'http', 'auth'],
  3: ['action', 'query', 'jobs', 'realtime'],
  4: ['render', 'pwa', 'mcp', 'ai', 'manifest', 'mail', 'ui'],
  5: ['admin', 'testing', 'cli', 'scraping'],
};

/**
 * Declared sideways edges — the contract allows same-tier imports only when they are listed, and
 * each of these earns its line.
 *
 * `admin -> ui` used to be here and is GONE, because it was never about composition: `ui` imports
 * `core`, `i18n`, `money` and `time`, so tier 2 is the lowest its real imports allow and tier 5
 * was two tiers too high. The exception existed only to undo that placement. `ui` sits at 4 rather
 * than at its floor so that `render -> ui` stays forbidden (both at 4), which
 * `packages/render/CLAUDE.md` requires — the static bundle graph may not reach the design system.
 * An exception line in an enforcement table is a rule with a hole in it; deleting the hole beats
 * arguing for it.
 *
 * | Edge | Why it is not a lower-tier extraction |
 * |---|---|
 * | `realtime -> query` | tier 3 is one feature: a live query is a query plus a subscription, and splitting it would duplicate the SQL shape |
 * | `create-ultimate -> cli` | a published shim whose whole job is to call `x new`; the alternative is a second copy of the templates |
 * | `cli -> admin` | `x dev` MOUNTS the `/_x` dashboard, it does not reimplement it; the panels are a product of the same tier, and the alternative is a second dev dashboard living in the CLI |
 * | `cli -> scraping` | `x shot` drives a real browser, and `@ultimat3/scraping` is the one package that can: it declares the CDP library's shape structurally (`cdp-port.ts`) and takes no runtime dependency, so the CLI passes the app's own `puppeteer` in. Moving `scraping` down to 4 would have removed the need for this line and is REFUSED: `packages/scraping/CLAUDE.md` places it at 5 deliberately, reserving room for `recover: 'agent'` to import `@ultimat3/ai` (tier 4), and a package at 4 cannot import a package at 4. That file predicted this edge before anything imported the package |
 * | `cli -> testing` | `@ultimat3/testing` IS the framework's harness, and `serve.live.test.ts` spawns the scaffolded `server.ts` as a child and has to let one real port through the seal. It was already live as `../../testing/src/sealed-network` — a relative specifier the checker could not see — and the alternatives are worse: core's `markListening()` would announce a socket a CHILD opened, and a second unseal in the CLI is a second sealed-network |
 */
export const SIDEWAYS_ALLOW: Readonly<Record<string, readonly string[]>> = {
  realtime: ['query'],
  cli: ['admin', 'scraping', 'testing'],
  'create-ultimate': ['cli'],
};

export const TIER_OF: ReadonlyMap<string, number> = new Map(
  Object.entries(TIERS).flatMap(([tier, packages]) =>
    packages.map((name): [string, number] => [name, Number.parseInt(tier, 10)]),
  ),
);

/** A package no table places. Nothing may import it, and it may import nothing but its edges. */
export const UNLISTED_TIER = 6;

/**
 * Above tier 5, deliberately rather than by fallback. `create-ultimate` resolved to
 * `UNLISTED_TIER` because it is absent from `TIERS`, and a tier of 6 makes every one of the 28
 * framework packages a legal LOWER-tier import — so the `create-ultimate -> cli` edge the doc
 * block above presents as earning its line restricted nothing at all. It stays out of `TIERS`
 * because that map is the prose table's executable copy (`tier-table-drift.test.ts` asserts them
 * row for row) and this package is not a row of it.
 */
export const ABOVE_TABLE: Readonly<Record<string, number>> = { 'create-ultimate': 6 };

/**
 * Packages whose ONLY permitted imports are their declared `SIDEWAYS_ALLOW` edges — no tier range
 * at all. `create-ultimate`'s whole job is to call `x new`; anything else it reaches for is a
 * second copy of something `@ultimat3/cli` already owns.
 */
export const EDGE_ONLY_PACKAGES: ReadonlySet<string> = new Set(['create-ultimate']);

export const tierOf = (packageName: string): number =>
  TIER_OF.get(packageName) ?? ABOVE_TABLE[packageName] ?? UNLISTED_TIER;

/** Takes the TIER, not the package name: a package being scaffolded is not in the table yet, so
 * resolving its name here answered `0-5` for every new package regardless of `--tier`. */
export const allowedTiersFor = (tier: number): string => `0-${Math.max(tier - 1, 0)}`;

/** What a package may import, as one phrase for a finding. An edge-only package has no range. */
export const allowedImportsFor = (packageName: string): string =>
  EDGE_ONLY_PACKAGES.has(packageName)
    ? `only ${(SIDEWAYS_ALLOW[packageName] ?? []).map((edge) => `@ultimat3/${edge}`).join(', ')}`
    : allowedTiersFor(tierOf(packageName));

export interface TierCheck {
  readonly allowed: boolean;
  readonly reason:
    | 'lower-tier'
    | 'declared-sideways'
    | 'same-tier'
    | 'upward'
    | 'edge-only'
    | 'unknown-package';
}

/** The whole rule, in one place: lower is fine, listed sideways is fine, everything else is not. */
export function checkTier(from: string, to: string): TierCheck {
  if (!TIER_OF.has(to) && SIDEWAYS_ALLOW[from]?.includes(to) !== true) {
    return { allowed: false, reason: 'unknown-package' };
  }
  if (SIDEWAYS_ALLOW[from]?.includes(to) === true) {
    return { allowed: true, reason: 'declared-sideways' };
  }
  if (EDGE_ONLY_PACKAGES.has(from)) return { allowed: false, reason: 'edge-only' };
  const fromTier = tierOf(from);
  const toTier = tierOf(to);
  if (toTier < fromTier) return { allowed: true, reason: 'lower-tier' };
  if (toTier === fromTier) return { allowed: false, reason: 'same-tier' };
  return { allowed: false, reason: 'upward' };
}

export const ALL_PACKAGES: readonly string[] = Object.values(TIERS).flat();
