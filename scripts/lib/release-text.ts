// The release's text rewrites and the lines it prints about itself: the manifest's own version, the
// sibling pins that make a lockstep release installable, the invocation a refusal repeats and the
// next step a finished bump owes. Pure strings, so `release.ts` and the tests share one copy.

import type { Bump } from './release-version';

/**
 * This run, re-stated from VALIDATED values only — never the raw argv — so a refusal's `fix:` can
 * repeat it with nothing a shell would read as syntax.
 */
export const releaseInvocation = (input: {
  readonly explicit: string | undefined;
  readonly bump: Bump | undefined;
  readonly dryRun: boolean;
  readonly json: boolean;
  /** Only after `bumpWindowFindings` held it to `ADVISORY_ID`: no shell syntax can reach here. */
  readonly security?: string | undefined;
  readonly rehearse?: boolean | undefined;
}): string =>
  [
    'bun run scripts/release.ts',
    input.explicit === undefined
      ? `--bump ${input.bump ?? 'patch'}`
      : `--version ${input.explicit}`,
    ...(input.security === undefined ? [] : [`--security ${input.security}`]),
    ...(input.dryRun ? ['--dry-run'] : []),
    ...(input.rehearse === true ? ['--rehearse'] : []),
    ...(input.json ? ['--json'] : []),
  ].join(' ');

/**
 * What a finished bump owes next. No tag: `.github/workflows/release-tag.yml` cuts the annotated
 * tag, the Release and the publish once ci.yml passes on the merged commit, and the hand tag this
 * line used to print was the step that kept going wrong.
 *
 * `fixes` is `Fixes #<n>` for a confirmed open ask: the PR body carries it, so the merge that is
 * the release closes the ask too. Without one the line is byte-identical to its old form — no
 * close promised that no ask answers.
 */
export const releaseNextLine = (version: string, fixes?: string): string =>
  fixes === undefined
    ? `  next      bun install, commit, open the \`chore: release ${version}\` PR; merging it is the release (release-tag.yml)`
    : `  next      bun install, commit, open the \`chore: release ${version}\` PR with \`${fixes}\` in the body; merging it is the release (release-tag.yml) and closes the ask`;

/**
 * The only dependency range a lockstep release rewrites — a caret or a tag is somebody's intent.
 * Semver's own shape, one optional prerelease then one optional build: `(?:[-+][\w.-]+)*` let `-`
 * both open a group and continue one, which backtracks exponentially on `0.0.0+----…` (CodeQL).
 */
export const EXACT_PIN = /^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/;

/**
 * The manifest's own `"version"`, which is the second key in every package.json here and so the
 * first match. Rewriting text rather than re-serialising JSON keeps key order, comments-by-blank-
 * line and the trailing newline exactly as committed — a release diff should be one line per file.
 */
export const setOwnVersion = (raw: string, version: string): string =>
  raw.replace(/"version":\s*"[^"]+"/, `"version": "${version}"`);

/**
 * Every `@ultimat3/*` dependency pin, exact ones only. Lockstep means a published package names
 * the sibling version it was tested against; leaving these behind is how `@ultimat3/jobs@1.0.0`
 * ships depending on `@ultimat3/core@0.0.1`, which is not on the registry and never will be.
 */
export const repinFrameworkDeps = (raw: string, version: string): string =>
  // `[a-z0-9-]`, not `[a-z-]`: `@ultimat3/i18n` carries digits in its name, and a class that
  // missed it left four manifests pinning i18n at the previous version straight through a release.
  raw.replace(/"(@ultimat3\/[a-z0-9-]+)":\s*"([^"]+)"/g, (match, name: string, range: string) =>
    EXACT_PIN.test(range) ? `"${name}": "${version}"` : match,
  );
