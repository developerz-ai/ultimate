#!/usr/bin/env bun

// Print one version's section body from `docs/changelog/<version>.md` — the GitHub Release's notes,
// which `.github/workflows/release-tag.yml` creates from it, so a Release says what the changelog says.
// From 30.0.0 a section opens with `### Highlights`, and the body is those plus where to read the
// rest (wiki/Stability.md): 29.4.0's raw 5,026-character section was nobody's 30-second read.
//
//   bun run scripts/release-notes.ts --version 1.2.3 [--json]     (--json: the body is .data.notes)

import { githubSlug as slugOf } from '@ultimat3/manifest';
import { flagString, parseScriptArgs } from './lib/args';
import { HIGHLIGHTS_HEADING, releaseHighlights } from './lib/changelog-highlights';
import type { Changelog } from './lib/changelog-sections';
import { loadChangelog, versionFile } from './lib/changelog-store';
import type { Finding } from './lib/log';
import { report } from './lib/log';
import { majorOf } from './lib/major-window';
import { UNRELEASED_PLACEHOLDER } from './lib/release-changelog';
import { repoRoot } from './lib/run';

const SCRIPT = 'release-notes';

/** How `parseChangelog` names `## [Unreleased]`, which has no version of its own. */
export const UNRELEASED_VERSION = 'unreleased';

/**
 * The lines between a section's heading and the next `## `, trimmed — `undefined` when the
 * changelog holds no such section. Located by `parseChangelog`, the gate's own reading of "the
 * 1.2.3 section", so this cannot pick a heading the changelog rule would not. `[Unreleased]`'s
 * placeholder is no note: an empty window reads as an empty body, never as "Nothing yet.".
 */
export function sectionBody(changelog: Changelog, version: string): string | undefined {
  const section = changelog.find((one) => one.version === version);
  if (section === undefined) return undefined;
  return section.lines
    .filter((line) => version !== UNRELEASED_VERSION || line.trim() !== UNRELEASED_PLACEHOLDER)
    .join('\n')
    .trim();
}

const SEMVER = /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/;

const REPO = 'https://github.com/developerz-ai/ultimate';

/**
 * The short body: the Highlights, the Upgrading walkthrough for a major (its heading's slug, the
 * `## 29.x → 30.0.0, entry by entry` form changelog-check holds every major to), and the full
 * section at the tag. Undefined for a section with no Highlights, which keeps its raw body.
 */
export function highlightNotes(changelog: Changelog, version: string): string | undefined {
  const bullets = releaseHighlights(changelog, version);
  if (bullets === undefined) return undefined;
  const major = majorOf(version);
  const walkthrough =
    major === undefined
      ? []
      : [
          `- Upgrading from ${major - 1}.x: ${REPO}/wiki/Upgrading#${slugOf(`${major - 1}.x → ${version}, entry by entry`)}`,
        ];
  return [
    HIGHLIGHTS_HEADING,
    '',
    ...bullets,
    '',
    '### Read more',
    '',
    ...walkthrough,
    `- Every entry: ${REPO}/blob/v${version}/${versionFile(version)}`,
    `- What a release promises: ${REPO}/wiki/Stability`,
  ].join('\n');
}

/** Every refusal before a Release could be created with notes that say nothing. */
export function notesFindings(
  changelog: Changelog,
  version: string | undefined,
): { readonly notes: string } | { readonly findings: readonly Finding[] } {
  if (version === undefined || !SEMVER.test(version)) {
    return {
      findings: [
        {
          code: 'X_CLI_BAD_FLAG',
          cause: '--version must be the semver version whose notes to print (e.g. 1.2.3)',
          fix: 'bun run scripts/release-notes.ts --version 1.2.3 --json',
          at: 'scripts/release-notes.ts',
        },
      ],
    };
  }
  const notes = highlightNotes(changelog, version) ?? sectionBody(changelog, version);
  if (notes === undefined || notes.length === 0) {
    return {
      findings: [
        {
          code: 'X_DOC_CHANGELOG_SECTION_INVALID',
          cause: `${versionFile(version)} holds ${notes === undefined ? 'no' : 'an empty'} \`## ${version}\` section, so the Release for v${version} would have no notes`,
          fix: `ls docs/changelog/ | sort -V | tail -5   # then write the ${version} notes in docs/changelog/${version}.md — scripts/release.ts --version ${version} promotes [Unreleased] into it`,
          at: versionFile(version),
        },
      ],
    };
  }
  return { notes };
}

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const version = flagString(args, 'version');
  const changelog = await loadChangelog(repoRoot());
  const read = notesFindings(changelog, version);
  if ('findings' in read) {
    report(
      { ok: false, script: SCRIPT, summary: 'no release notes', findings: read.findings },
      args.json,
    );
  }
  report(
    {
      ok: true,
      script: SCRIPT,
      summary: `the ${version} section of ${versionFile(version ?? '')}, ${read.notes.split('\n').length} line(s)`,
      lines: [read.notes, ''],
      data: { version, notes: read.notes },
    },
    args.json,
  );
}
