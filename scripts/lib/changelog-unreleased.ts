// `changelog-check`'s UNRELEASED-ENTRY rule: a change to shipped `packages/*/src` code (not a test,
// not a README) adds at least one `[Unreleased]` line to CHANGELOG.md, compared against where the
// branch left `origin/main`. The 31.28.0 release PR (#1153) was refused at the last step with
// `X_CHANGELOG_HIGHLIGHTS_MISSING` because the PRs before it shipped code and wrote no line.

import { CHANGELOG_PATH } from './changelog-format';
import { parseChangelog, UNRELEASED } from './changelog-sections';
import { CHANGELOG_DIR } from './changelog-store';
import type { Finding } from './log';

/** The opt-out: a pull-request label, read from the event payload CI already holds. */
export const NO_CHANGELOG_LABEL = 'no-changelog';

/** Shipped source: under a package's `src/`, and neither a test file nor prose. */
export const isShippedSource = (path: string): boolean =>
  /^packages\/[^/]+\/src\//.test(path) && !/\.test\.[cm]?tsx?$/.test(path) && !path.endsWith('.md');

/** A release's own notes file: the diff that ships `[Unreleased]` and empties it. */
export const isReleaseNotes = (path: string): boolean =>
  new RegExp(`^${RegExp.escape(CHANGELOG_DIR)}/\\d+\\.\\d+\\.\\d+\\.md$`).test(path);

/** The `[Unreleased]` entries of an index's text: its bullet lines, trimmed. Placeholder prose is no entry. */
const entries = (index: string): ReadonlySet<string> => {
  const section = parseChangelog(index, CHANGELOG_PATH).find((one) => one.version === UNRELEASED);
  return new Set(
    (section?.body ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /^[-*] \S/.test(line)),
  );
};

/** The `[Unreleased]` entries `head` holds that `base` did not — what this change wrote. */
export function addedUnreleasedEntries(base: string, head: string): readonly string[] {
  const had = entries(base);
  return [...entries(head)].filter((line) => !had.has(line));
}

/** The label names on a `pull_request` event payload; anything else holds none. */
export function eventLabels(payload: unknown): readonly string[] {
  if (typeof payload !== 'object' || payload === null) return [];
  const pr: unknown = Reflect.get(payload, 'pull_request');
  if (typeof pr !== 'object' || pr === null) return [];
  const labels: unknown = Reflect.get(pr, 'labels');
  if (!Array.isArray(labels)) return [];
  return labels.flatMap((label: unknown) => {
    const name: unknown =
      typeof label === 'object' && label !== null ? Reflect.get(label, 'name') : undefined;
    return typeof name === 'string' ? [name] : [];
  });
}

export interface UnreleasedInput {
  /** Every path the change touched, against the base; `undefined` when no base could be read. */
  readonly changed: readonly string[] | undefined;
  /** The paths the base does not have at all. */
  readonly added: readonly string[];
  /** CHANGELOG.md at the base (empty when it had none) and in the working tree. */
  readonly baseIndex: string;
  readonly headIndex: string;
  readonly labels: readonly string[];
}

export const UNRELEASED_FIX =
  "git diff --name-only origin/main -- 'packages/*/src'   # then add a line under ## [Unreleased] in CHANGELOG.md (### Added, ### Changed or ### Fixed) saying what a user of those packages sees; a change no user sees takes the label instead: gh pr edit --add-label no-changelog, then push again (the label is read from the run's event)";

/** The one finding this rule makes, or `undefined` when the change owes no line or wrote one. */
export function unreleasedGap(input: UnreleasedInput): Finding | undefined {
  if (input.labels.includes(NO_CHANGELOG_LABEL)) return undefined;
  if (input.changed === undefined) {
    return {
      code: 'X_CHANGELOG_UNRELEASED_EMPTY',
      cause:
        'this checkout has no origin/main, so the change could not be diffed and whether it owes an [Unreleased] line is unknown — refused rather than read as owing none',
      fix: 'git fetch --no-tags origin +refs/heads/main:refs/remotes/origin/main   # then rerun: bun run changelog-check --json',
      at: CHANGELOG_PATH,
    };
  }
  if (input.added.some(isReleaseNotes)) return undefined;
  const shipped = input.changed.filter(isShippedSource);
  if (shipped.length === 0) return undefined;
  if (addedUnreleasedEntries(input.baseIndex, input.headIndex).length > 0) return undefined;
  const named = shipped.slice(0, 5).join(', ');
  const more = shipped.length > 5 ? ` and ${String(shipped.length - 5)} more` : '';
  return {
    code: 'X_CHANGELOG_UNRELEASED_EMPTY',
    cause: `this change edits shipped source (${named}${more}) and adds no line under ## [Unreleased] in ${CHANGELOG_PATH}, so the release that ships it has nothing to say about it — the 31.28.0 release PR was refused for exactly that (X_CHANGELOG_HIGHLIGHTS_MISSING)`,
    fix: UNRELEASED_FIX,
    at: CHANGELOG_PATH,
  };
}
