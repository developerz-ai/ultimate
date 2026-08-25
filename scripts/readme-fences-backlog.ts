// The ratchet under `scripts/readme-fences.ts`: how many fenced `ts`/`tsx` examples in each
// package's `README.md` do not typecheck today. The number may FALL and may never rise — a new
// example must compile from the day it is written, and the 155 that do not get retired over time.
//
// Measured when this shipped: 170 fenced examples across 27 packages, 155 of them failing. Most are
// illustrative fragments — an identifier the surrounding prose defines, an app-level import that
// resolves in an app and not here, a signature shown with its arguments elided. Turning those into
// compiling programs is fixture engineering, not a formatting pass, so the honest artifact is a
// rule with a recorded edge rather than a rule switched off. Compiling a package's blocks TOGETHER
// was measured too, on the theory that block 4 uses what block 1 declared: 156 rather than 158,
// because an unparseable block has to leave the fixture and takes its declarations with it. Two
// designs, one answer — there is no cheap fixture that rescues these, only writing them out.
//
// A count, deliberately, and not a list of blocks: the README prose around an example is rewritten
// constantly, and a pin keyed on a line number or a content hash would go stale on every paragraph
// edit — churn that teaches a reader to regenerate the file without looking at it.
//
// Shrink it with `bun run scripts/readme-fences.ts --pin`, which lowers a count and refuses to
// raise one. Raising a count is a hand edit, on purpose, in a review.

export const README_FENCE_BACKLOG: Readonly<Record<string, number>> = {
  action: 10,
  admin: 6,
  ai: 16,
  auth: 8,
  cache: 10,
  core: 12,
  db: 5,
  entity: 14,
  flags: 4,
  i18n: 2,
  jobs: 12,
  mail: 1,
  manifest: 1,
  mcp: 2,
  policy: 4,
  pwa: 2,
  query: 5,
  realtime: 6,
  render: 4,
  schema: 5,
  seo: 4,
  storage: 3,
  testing: 6,
  time: 1,
  ui: 4,
};

/** What this package is allowed to have failing today. Absent means zero: a new package's
 * examples compile or its first `x verify` says so. */
export const pinnedFor = (
  pkg: string,
  backlog: Readonly<Record<string, number>> = README_FENCE_BACKLOG,
): number => backlog[pkg] ?? 0;
