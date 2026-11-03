// The npm dist-tag a version is published under — wiki/Stability.md's support row, as a rule:
// the current major is `latest`, a release of the previous major is `maint-<major>`, a prerelease
// is `next`. Pure; `scripts/dist-tag.ts` reads the registry and `registry-audit.ts` audits it.

import type { Finding } from './log';
import { compareReleaseVersions } from './release-preflight';

export const maintTag = (major: number): string => `maint-${major}`;

const majorOf = (version: string): number => Number.parseInt(version.split('.')[0] ?? '', 10);

/**
 * The tag that must point at `version` once it is published, given what `latest` points at now.
 * `npm publish` with no `--tag` moves `latest` to whatever it publishes, so a 29.x patch cut after
 * 30.0.0 would hand every `npm install` the older major: this is the tag that stops it.
 */
export function servingTag(version: string, latest: string | undefined): string {
  if (version.includes('-')) return 'next';
  if (latest === undefined || latest === 'none') return 'latest';
  const major = majorOf(version);
  return major < majorOf(latest) ? maintTag(major) : 'latest';
}

/** The publish's tag, or the refusal: an older release of the CURRENT major has no tag to take. */
export function distTagFor(
  version: string,
  latest: string | undefined,
): { readonly tag: string } | { readonly finding: Finding } {
  const tag = servingTag(version, latest);
  if (tag !== 'latest' || latest === undefined || compareReleaseVersions(version, latest) >= 0) {
    return { tag };
  }
  return {
    finding: {
      code: 'X_RELEASE_VERSION_INVALID',
      cause: `${version} is older than ${latest}, which npm's latest already names in the same major, so publishing it would move latest backwards`,
      fix: `bun run scripts/release.ts --bump patch --dry-run --json   # on the branch at ${latest}: a patch to the current major is cut from its newest minor (wiki/Stability.md)`,
      at: '.github/workflows/release.yml',
    },
  };
}
