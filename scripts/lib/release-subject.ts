// The two subjects a release is recognised by, one per reader — and the ask matcher over them.
// `RELEASE_SUBJECT` — a commit subject, read by `release-due.ts` (a bump ships nothing new) and
//   `deploy-proof-due.ts` (a release commit is proved on itself).
// `ASK_SUBJECT` — a GitHub issue title: `.dz/briefs/release-due.md` files one ask titled
//   `Release <next>` and never a second while one is open. The two readers are deliberately
//   disjoint, so neither regex may accept the other's text.
// `openReleaseAsk` / `askTwin` — that dedupe itself: is one of the OPEN issues a true ask for this
//   version? One matcher, two input shapes — titles (`release-due-rule.ts`) and {number,title}
//   rows (`release.ts`'s `gh issue list` lookup).

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
