// The gate's half of wiki/Stability.md, as one host rule for `scripts/verify.ts`: the major
// window over every released major, the Highlights every release from 30.0.0 opens with, no
// `BREAKING —` on main while the window is closed, the page's next-window date, and the exports.

import { deprecationWindowFindings } from '../deprecation-window';
import { CHANGELOG_PATH } from './changelog-format';
import { breakingOnMainFindings, highlightFindings, targetBranch } from './changelog-highlights';
import { parseChangelog } from './changelog-sections';
import type { Finding } from './log';
import { majorWindowFindings, nextMajorWindow, WINDOW_OPENS_AT_MAJOR } from './major-window';

export const STABILITY_PATH = 'wiki/Stability.md';
/** The one line on the page that states when the next major may ship. */
export const NEXT_WINDOW_LEAD = '**Next major window:**';

/** `YYYY-MM-DD` today, in UTC: the zone every changelog heading is dated in. */
export const todayUtc = (now: Date = new Date()): string => now.toISOString().slice(0, 10);

/** The pure rules over CHANGELOG.md's text. `env` names the branch a change is headed to. */
export function stabilityChangelogFindings(
  changelog: string,
  env: Readonly<Record<string, string | undefined>>,
  today: string,
): readonly Finding[] {
  // Each released major judged by its own heading date: the bump PR that dated it reds here.
  const windows = parseChangelog(changelog)
    // Only lines above the opener are windowed: the cheap filter keeps 300 sections from each re-parsing.
    .filter(
      (section) => section.released && Number.parseInt(section.version, 10) > WINDOW_OPENS_AT_MAJOR,
    )
    .flatMap((section) => majorWindowFindings({ version: section.version, changelog, today }));
  return [
    ...windows,
    ...highlightFindings(changelog),
    ...breakingOnMainFindings({ changelog, target: targetBranch(env), today }),
  ];
}

/** The next-window line the changelog derives, without its closing sentence. */
export function nextWindowLine(changelog: string): string {
  const window = nextMajorWindow(changelog);
  return window === undefined
    ? `${NEXT_WINDOW_LEAD} 90 days after the date on the \`## ${WINDOW_OPENS_AT_MAJOR}.0.0\` heading`
    : `${NEXT_WINDOW_LEAD} opens on \`${window.opensOn}\`, 90 days after ${window.after} (${window.on})`;
}

/**
 * The page with that line rewritten from `changelog` — what a release bump writes, so the
 * promoted section and the page's date land in one commit. A page already right is unchanged.
 */
export function withNextWindowLine(page: string, changelog: string): string {
  if (stabilityPageFindings(page, changelog).length === 0) return page;
  const lines = page.split('\n');
  const at = lines.findIndex((line) => line.startsWith(NEXT_WINDOW_LEAD));
  if (at === -1) return page;
  lines[at] =
    `${nextWindowLine(changelog)}. The bump that ships a major rewrites this line (\`scripts/release.ts\`).`;
  return lines.join('\n');
}

/**
 * The page's next-window line, held to the changelog: once the opener has shipped it names the date
 * `nextMajorWindow` derives, in backticks; before then it names no date. A hand-kept date is the
 * fact that goes stale the day a major ships, so it is checked rather than trusted.
 */
export function stabilityPageFindings(page: string, changelog: string): readonly Finding[] {
  const line = page.split('\n').find((one) => one.startsWith(NEXT_WINDOW_LEAD));
  const window = nextMajorWindow(changelog);
  const named = line?.match(/\d{4}-\d{2}-\d{2}/g) ?? [];
  const holds =
    line !== undefined &&
    (window === undefined ? named.length === 0 : line.includes(`\`${window.opensOn}\``));
  if (holds) return [];
  const want = nextWindowLine(changelog);
  return [
    {
      code: 'X_DOC_RELEASE_FACT_STALE',
      cause:
        line === undefined
          ? `${STABILITY_PATH} has no line starting ${NEXT_WINDOW_LEAD}, so the page states no next major date`
          : `${STABILITY_PATH}'s next-window line does not say what CHANGELOG.md derives: ${window === undefined ? `no major from ${WINDOW_OPENS_AT_MAJOR}.0.0 has shipped, so it names no date` : `${window.opensOn}, 90 days after ${window.after}`}`,
      fix: `grep -n 'Next major window' wiki/Stability.md   # make that line read "${want}.", then rerun: bun test scripts/lib/stability-findings.test.ts`,
      at: STABILITY_PATH,
    },
  ];
}

/** A file's text, or empty when it is absent: an absent page is a finding, never a crash. */
const textOrEmpty = async (path: string): Promise<string> => {
  const file = Bun.file(path);
  return (await file.exists()) ? file.text() : '';
};

export async function stabilityFindings(
  root: string,
  options: {
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly deprecations?: (root: string) => Promise<readonly Finding[]>;
  } = {},
): Promise<readonly Finding[]> {
  const changelog = await textOrEmpty(`${root}/${CHANGELOG_PATH}`);
  const page = await textOrEmpty(`${root}/${STABILITY_PATH}`);
  return [
    ...stabilityChangelogFindings(changelog, options.env ?? Bun.env, todayUtc()),
    ...stabilityPageFindings(page, changelog),
    ...(await (options.deprecations ?? deprecationWindowFindings)(root)),
  ];
}
