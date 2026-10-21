// The two subjects a release is recognised by, one per reader.
// `RELEASE_SUBJECT` — a commit subject, read by `release-due.ts` (a bump ships nothing new) and
//   `deploy-proof-due.ts` (a release commit is proved on itself).
// `ASK_SUBJECT` — a GitHub issue title, read only by a release-due dedupe: `.dz/briefs/release-due.md`
//   files one ask titled `Release <next>` and never a second while one is open. The two readers are
//   deliberately disjoint, so neither regex may accept the other's text.

/**
 * `chore: release 27.10.1 (#770)`, the squash-merged release PR, and `release: 6.0.0`, what
 * `scripts/release.ts` commits were titled before. A subject that only mentions a release is not one.
 */
export const RELEASE_SUBJECT = /^(?:chore(?:\([^)]*\))?: release|release:) \d+\.\d+\.\d+(?=\s|$)/;

/**
 * The title of the release-due ask, `Release 27.10.1` — capital `R`, no conventional-commit prefix,
 * which is why a separate regex and not a looser `RELEASE_SUBJECT`: a release commit subject is not
 * an ask. The two readers stay disjoint: the dedupe in `release-due-rule.ts` matches ask titles
 * through `ASK_SUBJECT` alone, so neither regex accepts the other's text.
 *
 * Anchored at BOTH ends, unlike `RELEASE_SUBJECT`. The version is the whole title the brief files
 * (`.dz/briefs/release-due.md`, "Title `Release <next>`"), so trailing prose is not an ask: a
 * failed-publish issue opened as `Release 27.10.1 failed to publish` would otherwise read as an open
 * ask under a trailing `(?=\s|$)` and suppress every future ask for that version forever.
 */
export const ASK_SUBJECT = /^Release \d+\.\d+\.\d+[ \t]*$/;
