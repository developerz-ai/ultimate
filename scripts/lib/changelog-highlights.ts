// Two CHANGELOG.md rules from wiki/Stability.md: every release section from 30.0.0 opens with a
// `### Highlights` of at most five bullets (the Release body), and once the major that opens the
// window has shipped a `BREAKING —` entry may not reach `main` while it is closed — it waits on `next`.

import { CHANGELOG_PATH } from './changelog-format';
import { parseChangelog, UNRELEASED } from './changelog-sections';
import type { Finding } from './log';
import { nextMajorWindow, recordedException } from './major-window';

export const HIGHLIGHTS_HEADING = '### Highlights';
export const MAX_HIGHLIGHTS = 5;
/**
 * The first major whose sections open with Highlights. Not the window's opener: the window moved
 * to v31 (2026-11-09 ruling) while every 30.x section already carries its Highlights.
 */
export const HIGHLIGHTS_FROM_MAJOR = 30;

/** The section's `### Highlights` bullets when it opens with them, else undefined. */
function openingHighlights(body: string): readonly string[] | undefined {
  const lines = body.split('\n');
  const first = lines.findIndex((line) => line.startsWith('### '));
  if (first === -1 || lines[first]?.trim() !== HIGHLIGHTS_HEADING) return undefined;
  const rest = lines.slice(first + 1);
  const end = rest.findIndex((line) => line.startsWith('### '));
  return (end === -1 ? rest : rest.slice(0, end)).filter((line) => line.startsWith('- '));
}

const highlighted = (version: string): boolean =>
  /^\d+\.\d+\.\d+$/.test(version) && Number.parseInt(version, 10) >= HIGHLIGHTS_FROM_MAJOR;

/** Every released section from 30.0.0 that does not open with 1–5 highlight bullets. */
export function highlightFindings(changelog: string): readonly Finding[] {
  return parseChangelog(changelog).flatMap((section): readonly Finding[] => {
    if (!section.released || !highlighted(section.version)) return [];
    const bullets = openingHighlights(section.body);
    if (bullets !== undefined && bullets.length > 0 && bullets.length <= MAX_HIGHLIGHTS) return [];
    const why =
      bullets === undefined
        ? `does not open with \`${HIGHLIGHTS_HEADING}\``
        : `opens with ${bullets.length} highlight bullet(s), where a Release body takes 1 to ${MAX_HIGHLIGHTS}`;
    return [
      {
        code: 'X_CHANGELOG_HIGHLIGHTS_MISSING',
        cause: `\`## ${section.heading}\` ${why}, so its GitHub Release would be the raw section with no summary (wiki/Stability.md)`,
        fix: `grep -n '^## ' CHANGELOG.md | head -5   # add ${HIGHLIGHTS_HEADING} as the first subsection of that section, at most ${MAX_HIGHLIGHTS} plain user-visible bullets, then rerun: bun run scripts/changelog-check.ts --json`,
        at: `${CHANGELOG_PATH}:${section.line}`,
      },
    ];
  });
}

/** The highlight bullets a Release body opens with, or undefined for a section that has none. */
export function releaseHighlights(
  changelog: string,
  version: string,
): readonly string[] | undefined {
  const section = parseChangelog(changelog).find((one) => one.version === version);
  const bullets = section === undefined ? undefined : openingHighlights(section.body);
  return bullets === undefined || bullets.length === 0 ? undefined : bullets;
}

/** The branch this change lands on: a PR's base, else the branch a push went to. */
export function targetBranch(
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const base = env['GITHUB_BASE_REF'];
  if (base !== undefined && base !== '') return base;
  return env['GITHUB_EVENT_NAME'] === 'push' ? env['GITHUB_REF_NAME'] : undefined;
}

/**
 * Once the window's opening major (`WINDOW_OPENS_AT_MAJOR`) ships, `main` ships minors and
 * patches only while the window is closed: a `BREAKING —` entry under [Unreleased] there is a
 * break that skipped `next`. Once the window opens, `next`
 * merging into `main` IS the major, so the rule lets it through; an advisory recorded under
 * [Unreleased] is the security exception. No target (a local run) reads nothing.
 */
export function breakingOnMainFindings(input: {
  readonly changelog: string;
  readonly target: string | undefined;
  readonly today: string;
}): readonly Finding[] {
  if (input.target !== 'main') return [];
  const window = nextMajorWindow(input.changelog);
  if (window === undefined || input.today >= window.opensOn) return [];
  if (recordedException(input.changelog, UNRELEASED) !== undefined) return [];
  const unreleased = parseChangelog(input.changelog).find((one) => one.version === UNRELEASED);
  const count = unreleased?.breaking ?? 0;
  if (count === 0) return [];
  return [
    {
      code: 'X_BREAKING_ON_MAIN',
      cause: `[Unreleased] holds ${count} \`BREAKING —\` ${count === 1 ? 'entry' : 'entries'} on a change to main, and the next major window opens on ${window.opensOn}: until then main ships minors and patches only (wiki/Stability.md)`,
      fix: 'git rebase --onto next main   # then retarget the pull request to next: gh pr edit --base next',
      at: `${CHANGELOG_PATH}:${unreleased?.line ?? 1}`,
    },
  ];
}
