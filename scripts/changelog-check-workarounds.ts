// `changelog-check`'s RETIRED-WORKAROUND rule, pure: a release note that says a feature retires a
// workaround (`retires the workaround \`<id>\``) names a row of `SUPERSEDED_WORKAROUNDS` whose
// `shippedIn` is that release, so `x doctor` and `x upgrade` tell every app still holding it.
// A note with no row would retire the workaround in prose only, which is no app's upgrade.

import type { Changelog } from './lib/changelog-sections';
import { UNRELEASED } from './lib/changelog-sections';
import type { Finding } from './lib/log';

/** The phrase a release author writes, then the row id in backticks. Case-insensitive. */
export const RETIRES_MARKER = 'retires the workaround';
export const WORKAROUND_UNTABLED = 'X_DOC_WORKAROUND_UNTABLED';
export const SUPERSEDED_TABLE = 'packages/cli/src/superseded.ts';

const MARKER = /retires the workaround(?:\s+`([^`]+)`)?/gi;

/** What the rule reads of a row: its id and the release it was shipped in. */
export interface TabledWorkaround {
  readonly id: string;
  readonly shippedIn: string;
}

export interface WorkaroundGap {
  /** `unnamed`: the marker with no id · `untabled`: no row · `version`: the row names another release. */
  readonly kind: 'unnamed' | 'untabled' | 'version';
  readonly at: string;
  readonly id: string;
  /** The section's version — `unreleased` before the release names one. */
  readonly version: string;
  readonly shippedIn?: string;
}

export function workaroundGaps(
  changelog: Changelog,
  rows: readonly TabledWorkaround[],
): readonly WorkaroundGap[] {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const gaps: WorkaroundGap[] = [];
  for (const section of changelog) {
    section.lines.forEach((text, index) => {
      const at = `${section.file}:${section.line + 1 + index}`;
      for (const match of text.matchAll(MARKER)) {
        const id = match[1]?.trim() ?? '';
        const base = { at, id, version: section.version };
        const row = byId.get(id);
        if (id === '') gaps.push({ kind: 'unnamed', ...base });
        else if (row === undefined) gaps.push({ kind: 'untabled', ...base });
        else if (section.version !== UNRELEASED && row.shippedIn !== section.version) {
          gaps.push({ kind: 'version', ...base, shippedIn: row.shippedIn });
        }
      }
    });
  }
  return gaps;
}

const RERUN = 'bun run scripts/changelog-check.ts --json';

/** Opens with the row to paste: the fix is code, never a sentence. */
export function workaroundFinding(gap: WorkaroundGap): Finding {
  const id = gap.id === '' ? 'the-workaround-id' : gap.id;
  const version = gap.version === UNRELEASED ? 'the-release-version' : gap.version;
  const row = `{ id: '${id}', pattern: { comment: [/the note an app wrote/i] }, shippedIn: '${version}', replacement: '…', fix: '…' }`;
  const cause =
    gap.kind === 'unnamed'
      ? `${gap.at} says a feature ${RETIRES_MARKER} and names no row id in backticks after it`
      : gap.kind === 'untabled'
        ? `${gap.at} retires the workaround '${gap.id}' and ${SUPERSEDED_TABLE} holds no row of that id, so x doctor tells no app`
        : `${gap.at} retires the workaround '${gap.id}' in ${gap.version}; its row says shippedIn '${gap.shippedIn}'`;
  const fix =
    gap.kind === 'version'
      ? `shippedIn: '${gap.version}' — on the '${gap.id}' row of ${SUPERSEDED_TABLE}, or move the line to the release that shipped it; then rerun: ${RERUN}`
      : `${row} — add it to SUPERSEDED_WORKAROUNDS in ${SUPERSEDED_TABLE} with its example in doctor-superseded.test.ts, and name its id in backticks after "${RETIRES_MARKER}"; then rerun: ${RERUN}`;
  return { code: WORKAROUND_UNTABLED, cause, fix, at: gap.at };
}
