// The subject a release commit lands on main under — one regex, read by both `release-due.ts`
// (a bump ships nothing new) and `deploy-proof-due.ts` (a release commit is proved on itself).

/**
 * `chore: release 27.10.1 (#770)`, the squash-merged release PR, and `release: 6.0.0`, what
 * `scripts/release.ts` commits were titled before. A subject that only mentions a release is not one.
 */
export const RELEASE_SUBJECT = /^(?:chore(?:\([^)]*\))?: release|release:) \d+\.\d+\.\d+(?=\s|$)/;
