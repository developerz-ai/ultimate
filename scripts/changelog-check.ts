#!/usr/bin/env bun
// Enforce, as a gate rule, that CHANGELOG.md's sections are well-formed, that every migration
// count in wiki/Upgrading.md is read out of that major's OWN section, and that each `BREAKING —`
// line names its Upgrading row one-to-one (`lib/changelog-pairing.ts`).
//
// The gap this closes is at commit 8fe7c56d — `git show 8fe7c56d:CHANGELOG.md`. That is
// `release: 6.0.0`, the release script's OWN output: seven `BREAKING —` entries still under
// `## [Unreleased]`, a `## 6.0.0` holding six merge subjects and nothing else, and two `## 5.0.1`
// plus two `## 5.0.0` headings carried over from the two runs before it — while wiki/Upgrading.md
// already told the reader to read the `6.0.0` section.
//
// Read the TAG and none of that is visible: `git show v6.0.0:CHANGELOG.md` has the migration inside
// `## 6.0.0` and no duplicate `## ` heading, because v6.0.0 points at 93443aeb — a human repairing
// 8fe7c56d by hand. The tag is evidence of the repair, never of the defect, and the repair is what
// this file replaces. Two `### Fixed` blocks inside 6.0.0 (`v6.0.0:CHANGELOG.md:129` and `:139`)
// are what the hand pass missed.
//
// The count that should have caught it WAS derived — from the whole file — and a migration filed
// under the wrong heading is invisible to a whole-file count, because a misplaced entry only makes
// the number smaller. Per-section is the entire point of this file.
//
//   bun run scripts/changelog-check.ts [--json]

import { parseScriptArgs } from './lib/args';
import { CHANGELOG_PATH, UPGRADING_PATH } from './lib/changelog-format';
import { checkPairing, pairingFinding } from './lib/changelog-pairing';
import type { ChangelogSection } from './lib/changelog-sections';
import {
  FIRST_MIGRATABLE_MAJOR,
  isArchived,
  parseChangelog,
  parseDerivedTotal,
  parseMigrationTable,
  parseUpgradeSections,
  retentionBoundary,
  UNRELEASED,
} from './lib/changelog-sections';
import type { Finding } from './lib/log';
import { report } from './lib/log';
import { repoRoot, run } from './lib/run';
import { claimGaps, treeClaims } from './lib/unreleased-claims';

const SCRIPT = 'changelog-check';

// The constants and parsers `lib/changelog-format.ts` and `lib/changelog-sections.ts` state once.
// Re-exported here for the callers that already name this module — `release-notes.ts`,
// `lib/release-changelog.ts`, `lib/changelog-pairing.test.ts`, this file's own test.
export { BREAKING_ENTRY, CHANGELOG_PATH, UPGRADING_PATH } from './lib/changelog-format';
export type { ChangelogSection, MigrationRow } from './lib/changelog-sections';
export {
  isArchived,
  parseChangelog,
  parseDerivedTotal,
  parseMigrationTable,
  parseUpgradeSections,
  retentionBoundary,
} from './lib/changelog-sections';

export type ChangelogGapKind =
  | 'duplicate'
  | 'empty'
  // A released section whose body is only the auto-generated `### Commits` block — `promoteUnreleased`
  // writes THAT shape when `[Unreleased]` has no human-written notes, so a section whose body starts
  // with `### Commits` is the file saying "this release shipped with no release notes of its own".
  // One kind, separate from `empty`, because the edit (write the notes above the block) is not the
  // edit `empty` names (delete or merge) — the kind is what picks the `fix:` line.
  | 'commits-only'
  | 'unreleased-breaking'
  | 'count'
  // A row whose target section does not exist is NOT a stale count: there is no section to read a
  // count from, so the edit is to the row or to CHANGELOG.md. One kind per edit, because the kind
  // is what picks the `fix:` line.
  | 'unknown-section'
  | 'missing-row'
  // A row exists and the section it names does not. Distinct from `missing-row` because the edit is
  // the walkthrough itself, and distinct from `unknown-section`, which is about CHANGELOG.md.
  | 'missing-section'
  | 'total'
  | 'unscanned';

export interface ChangelogGap {
  readonly kind: ChangelogGapKind;
  readonly at: string;
  readonly detail: string;
}

export interface ChangelogInput {
  readonly changelog: string;
  readonly upgrading: string;
  /** The version this commit is tagged as, when it is tagged — `undefined` between releases. */
  readonly taggedVersion?: string | undefined;
}

export function checkChangelog(input: ChangelogInput): readonly ChangelogGap[] {
  const gaps: ChangelogGap[] = [];
  const sections = parseChangelog(input.changelog);
  const byVersion = new Map<string, ChangelogSection>();

  for (const section of sections) {
    const first = byVersion.get(section.version);
    if (first !== undefined) {
      gaps.push({
        kind: 'duplicate',
        at: `${CHANGELOG_PATH}:${section.line}`,
        detail: `a second \`## ${section.heading}\` — ${section.version} is already the section at line ${first.line}`,
      });
      continue;
    }
    byVersion.set(section.version, section);
    if (section.released && !section.filled) {
      gaps.push({
        kind: 'empty',
        at: `${CHANGELOG_PATH}:${section.line}`,
        detail: `\`## ${section.heading}\` has no body, so the release it names says nothing`,
      });
    }
  }

  // The shape `promoteUnreleased` writes when `[Unreleased]` is empty: the section's body holds only
  // the auto-generated `### Commits` block, with no human-written release notes above it. A
  // section whose body STARTS with `### Commits` is one, because legitimate release notes start with
  // their own subheading (`### Added`, `### Fixed`, ...). Reported once per affected section so each
  // editing step has its own finding; iterating released sections only — `[Unreleased]` is the
  // place where the commit block is allowed to be the whole body, because its notes are not yet
  // written.
  for (const section of sections) {
    if (!section.released) continue;
    if (!section.body.startsWith('### Commits')) continue;
    gaps.push({
      kind: 'commits-only',
      at: `${CHANGELOG_PATH}:${section.line}`,
      detail: `\`## ${section.heading}\` body is the auto-generated \`### Commits\` block alone, so the release it names ships no human-written release notes`,
    });
  }

  const unreleased = byVersion.get(UNRELEASED);
  const stranded = unreleased?.breaking ?? 0;
  if (input.taggedVersion !== undefined && stranded > 0) {
    gaps.push({
      kind: 'unreleased-breaking',
      at: `${CHANGELOG_PATH}:${unreleased?.line ?? 1}`,
      detail: `${stranded} \`BREAKING —\` ${stranded === 1 ? 'entry sits' : 'entries sit'} under [Unreleased] at tag ${input.taggedVersion}, so the migration is not in ${input.taggedVersion}'s own section`,
    });
  }

  const rows = parseMigrationTable(input.upgrading);
  const single = rows.filter((row) => row.target !== undefined);
  if (single.length === 0) {
    gaps.push({
      kind: 'unscanned',
      at: UPGRADING_PATH,
      detail: 'no row sends the reader to a single version section, so this rule read nothing',
    });
    return gaps;
  }

  const boundary = retentionBoundary(sections);
  for (const row of single) {
    const section = byVersion.get(row.target ?? '');
    const actual = section?.breaking ?? 0;
    if (row.claimed === actual && section !== undefined) continue;
    // Archived on purpose: the section was deleted from CHANGELOG.md and the walkthrough kept.
    // Its count cannot be re-derived from a file that no longer carries it, and demanding one
    // would make trimming the changelog impossible without gutting the upgrade guide with it.
    if (section === undefined && isArchived(row.target ?? '', boundary)) continue;
    gaps.push(
      section === undefined
        ? {
            kind: 'unknown-section',
            at: `${UPGRADING_PATH}:${row.line}`,
            detail: `names a \`${row.target}\` section that ${CHANGELOG_PATH} does not have`,
          }
        : {
            kind: 'count',
            at: `${UPGRADING_PATH}:${row.line}`,
            detail: `claims ${row.claimed} breaking entries; the \`${row.target}\` section of ${CHANGELOG_PATH} holds ${actual}`,
          },
    );
  }

  // The in-flight major's row: skipped until 2026-09-22, so "**10** so far" was checked by nobody
  // until the release. Its section IS [Unreleased], and it must say what that section holds now.
  const pending = byVersion.get(UNRELEASED)?.breaking ?? 0;
  for (const row of rows.filter((candidate) => candidate.unreleased)) {
    if (row.claimed === pending) continue;
    gaps.push({
      kind: 'count',
      at: `${UPGRADING_PATH}:${row.line}`,
      detail: `claims ${row.claimed} breaking entries so far; [Unreleased] in ${CHANGELOG_PATH} holds ${pending}`,
    });
  }

  // Retained sections only — the aggregate row states what a `grep` over THIS file answers, and a
  // count that included archived majors could never be re-derived by the reader running it.
  const expectedTotal = single
    .filter((row) => byVersion.has(row.target ?? ''))
    .reduce((sum, row) => sum + (byVersion.get(row.target ?? '')?.breaking ?? 0), 0);
  for (const row of rows.filter((candidate) => candidate.aggregate)) {
    if (row.claimed === expectedTotal) continue;
    gaps.push({
      kind: 'count',
      at: `${UPGRADING_PATH}:${row.line}`,
      detail: `claims ${row.claimed} breaking entries in all; the per-major sections hold ${expectedTotal}`,
    });
  }

  // A major with no row is the 6.0.0 failure one step earlier: released, and no upgrade guide. A
  // major with a row and no SECTION is the same failure wearing the row as cover, which is how
  // 2.0.0 — the largest major this project has shipped — went six releases with no walkthrough.
  const walked = parseUpgradeSections(input.upgrading);
  for (const section of sections) {
    const major = /^(\d+)\.0\.0$/.exec(section.version)?.[1];
    if (major === undefined || Number.parseInt(major, 10) < FIRST_MIGRATABLE_MAJOR) continue;
    const hasRow = single.some((row) => row.target === section.version);
    if (!hasRow) {
      gaps.push({
        kind: 'missing-row',
        at: `${UPGRADING_PATH}:1`,
        detail: `${section.version} is a released major and no row sends the reader to its section`,
      });
    }
    // One edit per finding. A major with NEITHER a row nor a heading is one problem, and reporting
    // it as both hands the reader two fixes whose first steps contradict — write the row, write the
    // section. `missing-section` is the row-present case, which is what its own code documents.
    if (!hasRow || walked.has(section.version)) continue;
    gaps.push({
      kind: 'missing-section',
      at: `${UPGRADING_PATH}:1`,
      detail: `${section.version} is a released major and the page carries no \`→ ${section.version}, entry by entry\` heading, so the reader is sent to a section that does not exist`,
    });
  }

  const derived = parseDerivedTotal(input.upgrading);
  // RELEASED sections only, which is what the row it backs says: "every major section CHANGELOG.md
  // still carries". Summing [Unreleased] with them made the number move on every PR that landed a
  // breaking change and move BACK when the release promoted the section, so the doc could only be
  // right between merges — and the edit it demanded was to a number that the next release invalidates.
  const releasedTotal = sections.reduce(
    (sum, section) => (section.released ? sum + section.breaking : sum),
    0,
  );
  if (derived !== undefined && derived.claimed !== releasedTotal) {
    gaps.push({
      kind: 'total',
      at: `${UPGRADING_PATH}:${derived.line}`,
      detail: `promises the grep prints ${derived.claimed}; it prints ${releasedTotal}`,
    });
  }
  return gaps;
}

const RERUN = 'bun run scripts/changelog-check.ts --json';

export function changelogFinding(gap: ChangelogGap): Finding {
  if (gap.kind === 'duplicate' || gap.kind === 'empty') {
    return {
      code: 'X_DOC_CHANGELOG_SECTION_INVALID',
      cause: `${gap.at} ${gap.detail}`,
      fix: `merge the two sections into one, or delete the generated one, then rerun: ${RERUN}`,
      at: gap.at,
    };
  }
  if (gap.kind === 'commits-only') {
    return {
      code: 'X_DOC_CHANGELOG_SECTION_INVALID',
      cause: `${gap.at} ${gap.detail}`,
      // The edit is to the section, not to release tooling: write the human-written notes under the
      // same heading, above the auto-generated `### Commits` block `promoteUnreleased` will append
      // next. The "edit this file" fix-line form — a `fix:` the reader can paste into a `code_edit`
      // and act on without first reading another script.
      fix: `write human-written release notes for the version the cause names under its heading in CHANGELOG.md, above the auto-generated \`### Commits\` block at the bottom, then rerun: ${RERUN}`,
      at: gap.at,
    };
  }
  if (gap.kind === 'unreleased-breaking') {
    return {
      code: 'X_DOC_CHANGELOG_UNRELEASED_BREAKING',
      cause: `${gap.at} ${gap.detail}`,
      // `--dry-run` writes NOTHING (release.ts, `if (!dryRun)`), so naming it here handed the
      // reader a command that validates the promotion and does not perform it. Axiom 4 at the one
      // point it is read: state the edit, and say which command performs it and which only checks.
      fix: 'move those entries under the released version heading in CHANGELOG.md — a release performs this promotion (bun run scripts/release.ts --bump major), and --dry-run only validates it',
      at: gap.at,
    };
  }
  if (gap.kind === 'missing-row') {
    return {
      code: 'X_DOC_MIGRATION_COUNT_STALE',
      cause: `${gap.at} ${gap.detail}`,
      // The row does not exist, so there is no count to set — the edit is to write the row. A
      // literal path, never an interpolation: the fix-line rule reads these statically.
      fix: 'add a row to the summary table in wiki/Upgrading.md for the version the cause names, whose third cell reads "the `X.Y.Z` section, in order", then rerun: bun run scripts/changelog-check.ts --json',
      at: UPGRADING_PATH,
    };
  }
  if (gap.kind === 'missing-section') {
    return {
      code: 'X_DOC_MIGRATION_SECTION_MISSING',
      cause: `${gap.at} ${gap.detail}`,
      // A literal path, never an interpolation: the fix-line rule reads these statically.
      // No angle brackets: a fix line is pasted, and the test holds every one of them to that.
      fix: 'write the walkthrough in wiki/Upgrading.md under a heading of the form "## 1.x → 2.0.0, entry by entry" naming the version the cause names, one subsection per entry of that section of CHANGELOG.md, then rerun: bun run scripts/changelog-check.ts --json',
      at: UPGRADING_PATH,
    };
  }
  if (gap.kind === 'unknown-section') {
    return {
      code: 'X_DOC_MIGRATION_COUNT_STALE',
      cause: `${gap.at} ${gap.detail}`,
      fix: `point that row at a version CHANGELOG.md has a section for, or write the section it names in CHANGELOG.md, then rerun: ${RERUN}`,
      at: gap.at,
    };
  }
  if (gap.kind === 'unscanned') {
    return {
      code: 'X_DOC_MIGRATION_UNSCANNED',
      cause: `${gap.at} ${gap.detail}`,
      // A literal path, never an interpolation: the fix-line rule reads these statically.
      fix: 'restore the summary table in wiki/Upgrading.md — each row reads "the `X.Y.Z` section, in order"',
      at: UPGRADING_PATH,
    };
  }
  return {
    code: 'X_DOC_MIGRATION_COUNT_STALE',
    cause: `${gap.at} ${gap.detail}`,
    fix: `set that count from the section it names, never from the whole file: ${RERUN}`,
    at: gap.at,
  };
}

/** The tag on THIS commit, when there is one — the only moment [Unreleased] must be migration-free. */
export async function taggedVersion(root: string): Promise<string | undefined> {
  const tags = await run(['git', 'tag', '--points-at', 'HEAD'], { cwd: root });
  if (!tags.ok) return undefined;
  return tags.output
    .split('\n')
    .map((line) => /^v(\d+\.\d+\.\d+)$/.exec(line.trim())?.[1])
    .find((version) => version !== undefined);
}

export async function changelogGaps(root: string): Promise<readonly ChangelogGap[]> {
  return checkChangelog({
    changelog: await Bun.file(`${root}/${CHANGELOG_PATH}`).text(),
    upgrading: await Bun.file(`${root}/${UPGRADING_PATH}`).text(),
    taggedVersion: await taggedVersion(root),
  });
}

/**
 * Every finding this rule contributes, for a caller that folds it into a gate step. The count rule
 * above, the one-to-one pairing of each line with its row (`lib/changelog-pairing.ts`), and the
 * unreleased-claim rule.
 */
export const changelogFindings = async (root: string): Promise<readonly Finding[]> => {
  const changelog = await Bun.file(`${root}/${CHANGELOG_PATH}`).text();
  const upgrading = await Bun.file(`${root}/${UPGRADING_PATH}`).text();
  // Each file read ONCE, and every rule handed the same text: two reads could see two versions.
  return [
    ...checkChangelog({ changelog, upgrading, taggedVersion: await taggedVersion(root) }).map(
      changelogFinding,
    ),
    ...checkPairing(changelog, upgrading).map(pairingFinding),
    ...claimGaps(await treeClaims(root, changelog)),
  ];
};

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const findings = await changelogFindings(repoRoot());
  report(
    {
      ok: findings.length === 0,
      script: SCRIPT,
      summary:
        findings.length === 0
          ? `${CHANGELOG_PATH} sections are well-formed and every ${UPGRADING_PATH} count is read from its own section`
          : `${findings.length} finding(s): the changelog and the upgrade guide disagree`,
      findings,
    },
    args.json,
  );
}
