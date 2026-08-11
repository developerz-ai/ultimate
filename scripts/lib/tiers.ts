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
  4: ['render', 'pwa', 'mcp', 'ai', 'manifest', 'mail'],
  5: ['ui', 'admin', 'testing', 'cli'],
};

/**
 * Declared sideways edges — the contract allows same-tier imports only when they are listed, and
 * each of these earns its line:
 *
 * | Edge | Why it is not a lower-tier extraction |
 * |---|---|
 * | `admin -> ui` | the admin dashboard *is* the ui kit, composed; inverting it would mean shipping every widget through props |
 * | `realtime -> query` | tier 3 is one feature: a live query is a query plus a subscription, and splitting it would duplicate the SQL shape |
 * | `create-ultimate -> cli` | a published shim whose whole job is to call `x new`; the alternative is a second copy of the templates |
 * | `cli -> admin` | `x dev` MOUNTS the `/_x` dashboard, it does not reimplement it; the panels are a product of the same tier, and the alternative is a second dev dashboard living in the CLI |
 */
export const SIDEWAYS_ALLOW: Readonly<Record<string, readonly string[]>> = {
  admin: ['ui'],
  realtime: ['query'],
  cli: ['admin'],
  'create-ultimate': ['cli'],
};

export const TIER_OF: ReadonlyMap<string, number> = new Map(
  Object.entries(TIERS).flatMap(([tier, packages]) =>
    packages.map((name): [string, number] => [name, Number.parseInt(tier, 10)]),
  ),
);

/** Packages outside the table (create-ultimate) sit above tier 5 and may import anything below. */
export const UNLISTED_TIER = 6;

export const tierOf = (packageName: string): number => TIER_OF.get(packageName) ?? UNLISTED_TIER;

export const allowedTiersFor = (packageName: string): string =>
  `0-${Math.max(tierOf(packageName) - 1, 0)}`;

export interface TierCheck {
  readonly allowed: boolean;
  readonly reason: 'lower-tier' | 'declared-sideways' | 'same-tier' | 'upward' | 'unknown-package';
}

/** The whole rule, in one place: lower is fine, listed sideways is fine, everything else is not. */
export function checkTier(from: string, to: string): TierCheck {
  if (!TIER_OF.has(to) && SIDEWAYS_ALLOW[from]?.includes(to) !== true) {
    return { allowed: false, reason: 'unknown-package' };
  }
  if (SIDEWAYS_ALLOW[from]?.includes(to) === true) {
    return { allowed: true, reason: 'declared-sideways' };
  }
  const fromTier = tierOf(from);
  const toTier = tierOf(to);
  if (toTier < fromTier) return { allowed: true, reason: 'lower-tier' };
  if (toTier === fromTier) return { allowed: false, reason: 'same-tier' };
  return { allowed: false, reason: 'upward' };
}

export const ALL_PACKAGES: readonly string[] = Object.values(TIERS).flat();
