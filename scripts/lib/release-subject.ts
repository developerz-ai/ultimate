// The two subjects a release is recognised by, one per reader — and the dedupes over them.
// `RELEASE_SUBJECT` — a commit subject, or the title of a release PR: read by `release-due.ts` (a
//   bump ships nothing new, and an open bump PR for the very next version is the release already
//   in flight) and by `deploy-proof-due.ts` (a release commit is proved on itself).
// `ASK_SUBJECT` — a GitHub issue title: `.dz/briefs/release-due.md` files one ask titled
//   `Release <next>` and never a second while one is open. The two readers are deliberately
//   disjoint, so neither regex may accept the other's text.
// `openReleaseAsk` / `askTwin` and `openReleaseBump` / `prTwin` — those dedupes themselves, one
//   matcher per reader over two input shapes: titles (`release-due-rule.ts`) and {number,title}
//   rows from the CLI (`scripts/release.ts` for the ask, `scripts/release-due.ts` for the bump).

/**
 * `chore: release 27.10.1 (#770)`, the squash-merged release PR, and `release: 6.0.0`, what
 * `scripts/release.ts` commits were titled before. A subject that only mentions a release is not one.
 */
export const RELEASE_SUBJECT = /^(?:chore(?:\([^)]*\))?: release|release:) \d+\.\d+\.\d+(?=\s|$)/;

/**
 * The title of the release-due ask, `Release 27.10.1` — capital `R`, no conventional-commit prefix,
 * which is why a separate regex and not a looser `RELEASE_SUBJECT`: a release commit subject is not
 * an ask. The two readers stay disjoint: `openReleaseAsk` below matches ask titles through
 * `ASK_SUBJECT` alone, so neither regex accepts the other's text.
 *
 * Anchored at BOTH ends, unlike `RELEASE_SUBJECT`. The version is the whole title the brief files
 * (`.dz/briefs/release-due.md`, "Title `Release <next>`"), so trailing prose is not an ask: a
 * failed-publish issue opened as `Release 27.10.1 failed to publish` would otherwise read as an open
 * ask under a trailing `(?=\s|$)` and suppress every future ask for that version forever.
 */
export const ASK_SUBJECT = /^Release \d+\.\d+\.\d+[ \t]*$/;

/** The release-due dedupe: `.dz/briefs/release-due.md` files one ask titled
 * `Release <next>` and never a second while one is open. A twin is an OPEN issue whose title is
 * exactly `Release <version>` — a failed-publish issue titled `Release 27.10.1 failed to publish`
 * does not match `ASK_SUBJECT`, so it never suppresses the real ask. Pure over the titles the
 * caller hands it. */
export interface OpenAsk {
  /** Whether any open issue is already an ask for `targetVersion`. */
  readonly open: boolean;
  /** The one open title that is a true twin, when one exists. */
  readonly twin?: string;
}

export function openReleaseAsk(openIssueTitles: readonly string[], targetVersion: string): OpenAsk {
  // ASK_SUBJECT is anchored at both ends, so a title it accepts is exactly `Release <version>`
  // and the version is title.slice("Release ".length). Compare the whole version, never a prefix:
  // `Release 27.10.10` also starts with `27.10.1` and is a different release.
  const twin = openIssueTitles.find((title) => {
    if (!ASK_SUBJECT.test(title)) return false;
    return title.slice('Release '.length).trimEnd() === targetVersion;
  });
  return twin === undefined ? { open: false } : { open: true, twin };
}

/** One `gh issue list --json number,title` row: what a release names the ask it closes by. */
export interface AskIssue {
  readonly number: number;
  readonly title: string;
}

/**
 * The dedupe over issue rows: the twin ISSUE, not just its title, so a release can name what it
 * closes. Composes `openReleaseAsk` — one matcher, so one definition of a true ask — and returns
 * the row whose title won.
 */
export const askTwin = (issues: readonly AskIssue[], version: string): AskIssue | undefined => {
  const ask = openReleaseAsk(
    issues.map((issue) => issue.title),
    version,
  );
  return ask.open ? issues.find((issue) => issue.title === ask.twin) : undefined;
};

/** One CLI pull-request row, `{number,title}`: the bump PR, which a report may name by its number
 * as well as by its title. */
export interface AskPr {
  readonly number: number;
  readonly title: string;
}

/**
 * The CLI arguments listing the OPEN bump PRs for `version` — the query `.dz/briefs/release-due.md`
 * states, beside `askIssueArgs` in `scripts/release.ts` and over the same `number,title` rows. The
 * search word is lower-case because the title search is case-insensitive and one matcher must see
 * every candidate; `openReleaseBump` below then rejects the issue-side `Release <version>` the
 * search also returns, which is what keeps the two readers disjoint. The binary itself is the
 * caller's.
 */
export const askPrArgs = (version: string): readonly string[] => [
  'pr',
  'list',
  '--state',
  'open',
  '--search',
  `release ${version} in:title`,
  '--json',
  'number,title',
];

/**
 * The `--json number,title` answer, read tolerantly — the mirror of `parseAskIssues` in
 * `scripts/release.ts`: anything that is not the rows the CLI promised (an error line, a truncated
 * answer, some future version's new shape) is no PR at all, and a malformed row drops out of the
 * array rather than failing the decision.
 */
export const parsePrIssues = (output: string): readonly AskPr[] => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const isAskPr = (row: unknown): row is AskPr =>
    typeof row === 'object' &&
    row !== null &&
    typeof (row as { number?: unknown }).number === 'number' &&
    typeof (row as { title?: unknown }).title === 'string';
  return parsed.filter(isAskPr);
};

/** The bump-PR twin of `OpenAsk`, one type per reader so the two are never interchanged. */
export interface OpenBump {
  /** Whether any open PR is already this version's bump. */
  readonly open: boolean;
  /** The one open title that is a true twin, when one exists. */
  readonly twin?: string;
}

/**
 * The bump-PR dedupe: merging an open `chore: release <version>` PR IS the release
 * (`.dz/briefs/release-due.md`), so while one is open the box files nothing and cuts nothing. Read
 * through `RELEASE_SUBJECT` — the commit-subject reader, which is also how this repo titles its
 * release PRs — and never through `ASK_SUBJECT`: `Release 27.10.1` is the ask, not this.
 */
export function openReleaseBump(openPrTitles: readonly string[], targetVersion: string): OpenBump {
  const twin = openPrTitles.find((title) => {
    const matched = RELEASE_SUBJECT.exec(title)?.[0];
    if (matched === undefined) return false;
    // RELEASE_SUBJECT stops at a token boundary, so the last token of what it matched IS the
    // version — and it is compared whole, never as a prefix: `27.10.10` also starts with `27.10.1`.
    const words = matched.split(/\s+/);
    return words[words.length - 1] === targetVersion;
  });
  return twin === undefined ? { open: false } : { open: true, twin };
}

/**
 * The dedupe over PR rows: the twin PR, not just its title, so a report can name the number. The
 * `askTwin` of the openReleaseAsk — composes `openReleaseBump`, one matcher, one definition of a
 * true bump, and returns the row whose title won.
 */
export const prTwin = (prs: readonly AskPr[], version: string): AskPr | undefined => {
  const bump = openReleaseBump(
    prs.map((pr) => pr.title),
    version,
  );
  return bump.open ? prs.find((pr) => pr.title === bump.twin) : undefined;
};
