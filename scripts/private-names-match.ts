// What the public-tree guard (`scripts/private-names.ts`) refuses, as pure matchers over one line:
// the internal setup mode's name, built from parts so this file never carries it whole, and the
// entries of the ULTIMATE_PRIVATE_NAMES secret — an adopter name (a whole token) or, with a `/`,
// a private repository (`owner/name`, a reader cannot open it).

/** The one variable the deny-list is read from. */
export const ENV_NAME = 'ULTIMATE_PRIVATE_NAMES';

/**
 * The internal setup mode that once wrote agent, skill and script text here. Assembled from parts:
 * the name is already in this repository's history, and what the guard buys is that the tree
 * stops carrying it again — so the guard itself must never be a copy. Spaced, joined or
 * underscored spellings are the same name.
 */
const SETUP_MODE = new RegExp(`(?<![a-z0-9])${['dz', 'runner'].join('[-_ ]?')}(?![a-z0-9])`);

/** The secret, parsed: adopter names and private repositories, both trimmed and lowercased. */
export interface DenyList {
  readonly names: readonly string[];
  readonly repositories: readonly string[];
}

/** Newline- or comma-separated; an entry holding a `/` is a repository. Unset is none of either. */
export function denyListFromEnv(env: Readonly<Record<string, string | undefined>>): DenyList {
  const entries = (env[ENV_NAME] ?? '')
    .split(/[\n,]/)
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
  return {
    names: entries.filter((entry) => !entry.includes('/')),
    repositories: entries.filter((entry) => entry.includes('/')),
  };
}

/** Letters, digits, `.` and `-` make a token; a name matches a WHOLE token, never part of one. */
const TOKEN = /[a-z0-9.-]+/g;

/**
 * The 1-based index of the entry a token is, or undefined. A token loses a leading or trailing `.`
 * or `-` first (a sentence's full stop), and a dotted entry also matches as a subdomain
 * (`www.<entry>`), since a domain's host part is still the name.
 */
export function tokenMatch(raw: string, names: readonly string[]): number | undefined {
  const word = raw.replace(/^[.-]+|[.-]+$/g, '');
  for (const [index, name] of names.entries()) {
    if (word === name || (name.includes('.') && word.endsWith(`.${name}`))) return index + 1;
  }
  return undefined;
}

/** The 1-based index of the first adopter name a lowercased line carries, or undefined. */
export function nameMatch(lower: string, names: readonly string[]): number | undefined {
  for (const [token] of lower.matchAll(TOKEN)) {
    const index = tokenMatch(token, names);
    if (index !== undefined) return index;
  }
  return undefined;
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * One matcher per repository entry: `owner/name` bounded on both sides, so `owner/name-tools`
 * and `xowner/name` pass, while `owner/name#12`, `owner/name.git` and a URL's path all match.
 */
export function repositoryMatchers(repositories: readonly string[]): readonly RegExp[] {
  return repositories.map(
    (entry) =>
      new RegExp(`(?<![a-z0-9._-])${escapeRegExp(entry)}(?:\\.git)?(?![a-z0-9_-]|\\.[a-z0-9])`),
  );
}

/** What one line carries, first found: the setup mode, then a repository, then an adopter name. */
export type LineHit =
  | { readonly kind: 'setup-mode' }
  | { readonly kind: 'repository' | 'name'; readonly index: number };

/** `names` is empty for a record, which the adopter-name rule leaves to its history. */
export function lineHit(
  text: string,
  names: readonly string[],
  repositories: readonly RegExp[],
): LineHit | undefined {
  const lower = text.toLowerCase();
  if (SETUP_MODE.test(lower)) return { kind: 'setup-mode' };
  const repository = repositories.findIndex((matcher) => matcher.test(lower));
  if (repository >= 0) return { kind: 'repository', index: repository + 1 };
  const name = nameMatch(lower, names);
  return name === undefined ? undefined : { kind: 'name', index: name };
}
