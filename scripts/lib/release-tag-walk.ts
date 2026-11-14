// Which changelog versions a walk for the last release tag may ask about. A bump PR's newest
// section is untagged, and so is a release stamped but never published (31.22.2: its CI was red,
// 31.22.3 shipped it) — both skipped; a longer untagged run is a tagless origin, refused.

import type { Changelog } from './changelog-sections';

/**
 * How many untagged sections a walk may pass: the one being cut and up to two never published.
 * Past it the walk refuses instead of asking origin for every version the changelog names.
 */
export const MAX_UNTAGGED_SECTIONS = 3;

/** The released, bare-semver sections, newest first: the versions a release tag can name. */
export const releasedVersions = (changelog: Changelog): readonly string[] =>
  // `[Unreleased]` parses to `unreleased`, which no semver pattern matches.
  changelog.map((section) => section.version).filter((version) => /^\d+\.\d+\.\d+$/.test(version));
