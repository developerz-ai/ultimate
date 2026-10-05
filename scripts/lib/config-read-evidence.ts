// What counts as EVIDENCE that a config leaf is read: the bare read, the qualified
// `<section>.<key>`, the package a section belongs to, and the point past which a bare-name match
// stops being evidence (`ambiguityOf`). `scripts/config-readers.ts` is the ratchet built on them.

import { ALL_PACKAGES } from './tiers';

/**
 * `.key` or `{ …, key }` / `{ key, … }`. A declaration (`readonly key: T;`) and a literal
 * (`key: 'UTC',`) both fail it, which is what keeps a scaffold template that WRITES the key out of
 * the reader set — `packages/cli/src/templates/` emits `defaultTimeZone: 'UTC'` and reads nothing.
 */
export const readPattern = (leaf: string): RegExp => {
  const key = leaf.split('.').at(-1) as string;
  return new RegExp(`\\.${key}\\b|(?<![\\w$.])${key}\\s*[,}]`);
};

/**
 * The QUALIFIED form — `realtime.tier`, `config.realtime.tier`, `cfg . realtime . tier` — which is
 * the only conclusive evidence text can offer. Undefined for a top-level leaf, which has no section
 * to qualify it with.
 *
 * Measured 2026-08-23 across all 28 leaves: this pattern matches in ZERO files for 19 of them,
 * `database.driver` and `jobs.concurrency` included — a package takes `CacheConfig` as a parameter
 * and reads `cfg.driver`, so demanding this form would report nineteen live keys as dead. It is
 * therefore a POSITIVE signal only: a match silences the ambiguity rule below, and a miss says
 * nothing on its own.
 */
export const qualifiedPattern = (leaf: string): RegExp | undefined => {
  const parts = leaf.split('.');
  if (parts.length < 2) return undefined;
  const [section, key] = parts.slice(-2) as [string, string];
  return new RegExp(`(?<![\\w$])${section}\\s*\\.\\s*${key}(?![\\w$])`);
};

/**
 * The package a section's keys belong to, where the two names differ. Two rows, and both are
 * asserted against the real package list by this rule's own test — a rename that made a row resolve
 * to nothing would silently switch the ambiguity check off for every key in that section, which is
 * the failure mode this whole rule exists to remove one level up.
 */
export const SECTION_PACKAGE: Readonly<Record<string, string>> = {
  database: 'db',
  // why: `AppConfig.drain` (plan 101 slice 01) is core's lifecycle budget; no package is named `drain`.
  drain: 'core',
  // why: `AppConfig.health` is what core's `/readyz` answers on; no package is named `health`.
  health: 'core',
  // why: `AppConfig.site` is the public origin; the CLI's document and sitemap builders read it.
  site: 'cli',
  // why: `AppConfig.navigation` is the client router's opt-in; the CLI reads it to build and name
  // the router (`page-navigation.ts`), and no package is named `navigation`.
  navigation: 'cli',
  // why: `AppConfig.islands` is the island bundler's opt-in (`island-bundle.ts`); no package is
  // named `islands`.
  islands: 'cli',
  theme: 'ui',
};

/**
 * `realtime.tier` -> `realtime`; `ai.mcp.path` -> `mcp`; a top-level leaf -> undefined.
 *
 * THE DEEPEST ANCESTOR THAT NAMES A PACKAGE, not simply the second-to-last segment, `As of
 * 2026-08-27`. `ai.mcp.path` wants `mcp` rather than `ai`, which is why the deepest one is tried
 * first — but `pwa.colors.light.themeColor` wants `pwa`, and `at(-2)` answered `light`, a value
 * shape rather than a subsystem. Every key of that section would then have been looked for in a
 * `packages/light/` that does not exist, which switches the ambiguity check off silently for all
 * four — the failure mode this rule's own header names. Nothing had a four-level key until the
 * walk learned to descend into an OPTIONAL section.
 */
export const owningPackage = (leaf: string): string | undefined => {
  const parts = leaf.split('.');
  if (parts.length < 2) return undefined;
  const ancestors = parts.slice(0, -1).reverse();
  for (const segment of ancestors) {
    const mapped = Object.hasOwn(SECTION_PACKAGE, segment) ? SECTION_PACKAGE[segment] : segment;
    if (mapped !== undefined && ALL_PACKAGES.includes(mapped)) return mapped;
  }
  // A section naming no package at all is still an owner — the ambiguity rule looks for a hit
  // inside `packages/<owner>/` and simply finds none, which is the same answer it gave before.
  const section = parts[0] as string;
  return Object.hasOwn(SECTION_PACKAGE, section) ? SECTION_PACKAGE[section] : section;
};

/**
 * How many unrelated files may match a bare leaf name before the match stops being evidence.
 *
 * Eight, measured. `realtime.tier` had NINETEEN matching files and not one of them in
 * `packages/realtime/` — `@ultimat3/cache`'s `CacheTier` and `@ultimat3/query`'s read-tier
 * vocabulary account for most, and `packages/policy/src/surfaces.ts` matched on the words `tier,`
 * in its FILE-HEADER PROSE while importing only `./errors`, `./evaluate` and `./policy`. The key
 * was read by nothing and this rule printed `✓`. The header above called the looseness safe because
 * it "only ever HIDES a dead key whose name collides with an unrelated property"; hiding a dead key
 * is the entire defect this rule exists for, so the sentence conceded the check away.
 *
 * Eight is where the four suspects separate from the twenty-four keys that have a hit inside their
 * own package: every leaf with a real reader has at least one, and the four that do not
 * (`realtime.tier` 19, `theme.tokens` 24, `pwa.enabled` 10, `realtime.enabled` 10) are the ones a
 * human should look at. Lowering it is a pin table with more rows, never a weaker rule.
 */
export const AMBIGUOUS_LIMIT = 8;

export interface ConfigSource {
  readonly path: string;
  readonly text: string;
}

/**
 * Whether a leaf's "reader" set is evidence at all. Three conditions, all of them necessary:
 * no qualified `<section>.<key>` anywhere, no bare match inside the section's OWN package, and
 * more than `AMBIGUOUS_LIMIT` bare matches outside it. A top-level leaf has no owning package and
 * is never asked — stated rather than silently skipped, and the honest limit of this rule.
 */
export function ambiguityOf(
  leaf: string,
  files: readonly ConfigSource[],
): { readonly readers: number; readonly colliding: readonly string[] } | undefined {
  const owner = owningPackage(leaf);
  if (owner === undefined) return undefined;
  const qualified = qualifiedPattern(leaf);
  if (qualified !== undefined && files.some((file) => qualified.test(file.text))) return undefined;
  const bare = readPattern(leaf);
  const hits = files.filter((file) => bare.test(file.text));
  if (hits.some((file) => file.path.startsWith(`packages/${owner}/`))) return undefined;
  if (hits.length <= AMBIGUOUS_LIMIT) return undefined;
  return { readers: hits.length, colliding: hits.slice(0, 2).map((file) => file.path) };
}
