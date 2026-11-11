// The major window (wiki/Stability.md): from v31, at most one major per 90 days, read from the
// dated section headings of docs/changelog/. Pure — the changelog and today are the
// caller's — so `release.ts --bump`, `release.ts --check` and the gate all ask one function.

import { type Changelog, parseChangelog } from './changelog-sections';
import type { Finding } from './log';
import { report } from './log';

export const MAJOR_WINDOW_DAYS = 90;
/**
 * The major that starts the clock. It is never refused itself: the plan's breaks land in it. v31
 * since the 2026-11-09 ruling (plan 101-final-hardening-before-v31): v30 opens no window.
 */
export const WINDOW_OPENS_AT_MAJOR = 31;
export const STABILITY_PAGE = 'https://github.com/developerz-ai/ultimate/wiki/Stability';

/** A GitHub advisory (`GHSA-xxxx-xxxx-xxxx`, its own alphabet) or a CVE id: nothing looser. */
export const ADVISORY_ID = /^(?:GHSA(?:-[23456789cfghjmpqrvwx]{4}){3}|CVE-\d{4}-\d{4,})$/;

const RECORDED = /^> \*\*Security exception:\*\* `([^`]+)`/m;
const DATED = /^\d+\.\d+\.\d+ - (\d{4}-\d{2}-\d{2})$/;
const DAY_MS = 86_400_000;

/** The line `release.ts --security <id>` writes under the section heading: the record of why. */
export const securityExceptionLine = (id: string): string =>
  `> **Security exception:** \`${id}\` — a major inside the ${MAJOR_WINDOW_DAYS}-day window, allowed by [Stability](${STABILITY_PAGE}#the-security-exception).`;

/** `X` for exactly `X.0.0`: the heading spelling the Upgrading walkthrough is keyed by. */
export const majorOf = (version: string): number | undefined => {
  const match = /^(\d+)\.0\.0$/.exec(version);
  return match === null ? undefined : Number.parseInt(match[1] ?? '', 10);
};

/** `X` of any release `X.Y.Z`; undefined for a prerelease or anything that is not a version. */
const lineOf = (version: string): number | undefined => {
  const match = /^(\d+)\.\d+\.\d+$/.exec(version);
  return match === null ? undefined : Number.parseInt(match[1] ?? '', 10);
};

/** `YYYY-MM-DD` plus whole days, in UTC — never the machine's zone. */
export const addDays = (date: string, days: number): string =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

const daysBetween = (from: string, to: string): number =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

interface DatedMajor {
  readonly version: string;
  readonly major: number;
  readonly date: string | undefined;
  readonly body: string;
}

/**
 * The release that OPENED each major line: its oldest released section, whatever its spelling. A
 * major is "the first release of a new major", never "a version that reads X.0.0": `31.1.0` cut
 * from 30.x opens the 31 line exactly as `31.0.0` would, and must wait for the window the same way.
 */
const majors = (changelog: Changelog): readonly DatedMajor[] => {
  const opened = new Map<number, DatedMajor>();
  // Newest first on the page, so the last section seen for a line is the one that opened it.
  for (const section of changelog) {
    const major = lineOf(section.version);
    if (!section.released || major === undefined) continue;
    const date = DATED.exec(section.heading)?.[1];
    opened.set(major, { version: section.version, major, date, body: section.body });
  }
  return [...opened.values()];
};

/** Whether `version` would open (or did open) its major line: no older release of that line. */
export const opensMajorLine = (version: string, changelog: Changelog): boolean => {
  const major = lineOf(version);
  if (major === undefined) return false;
  const opener = majors(changelog).find((one) => one.major === major);
  return opener === undefined || opener.version === version;
};

/** The advisory a released section records, when it records one. */
export const recordedException = (changelog: Changelog, version: string): string | undefined => {
  const section = changelog.find((one) => one.version === version);
  return section === undefined ? undefined : RECORDED.exec(section.body)?.[1];
};

/** The newest major from the opener on, and the day the next one may ship. Undefined before it. */
export function nextMajorWindow(
  changelog: Changelog,
): { readonly after: string; readonly on: string; readonly opensOn: string } | undefined {
  const newest = majors(changelog)
    .filter((one) => one.major >= WINDOW_OPENS_AT_MAJOR && one.date !== undefined)
    .sort((a, b) => b.major - a.major)[0];
  if (newest?.date === undefined) return undefined;
  return {
    after: newest.version,
    on: newest.date,
    opensOn: addDays(newest.date, MAJOR_WINDOW_DAYS),
  };
}

const refusal = (cause: string, opensOn: string | undefined): Finding => ({
  code: 'X_RELEASE_MAJOR_WINDOW',
  cause,
  fix: `bun run scripts/release.ts --bump major --security GHSA-xxxx-xxxx-xxxx --dry-run --json   # only for a security fix that cannot be non-breaking; otherwise the break waits on the next branch${opensOn === undefined ? '' : ` until ${opensOn}`} (wiki/Stability.md)`,
  at: 'docs/changelog/',
});

/**
 * Whether `version` may ship as a major today. A section the changelog already holds is judged by
 * its own heading date and its own recorded advisory, so the gate and `--check` reach the verdict
 * the bump reached; one it does not hold yet is the bump itself, judged on `today`.
 */
export function majorWindowFindings(input: {
  readonly version: string;
  readonly changelog: Changelog;
  readonly today: string;
  readonly security?: string | undefined;
}): readonly Finding[] {
  const major = lineOf(input.version);
  if (major === undefined || major <= WINDOW_OPENS_AT_MAJOR) return [];
  if (!opensMajorLine(input.version, input.changelog)) return [];
  const all = majors(input.changelog);
  const own = all.find((one) => one.version === input.version);
  const date = own?.date ?? input.today;
  const security = input.security ?? (own === undefined ? undefined : RECORDED.exec(own.body)?.[1]);
  const previous = all
    .filter((one) => one.major >= WINDOW_OPENS_AT_MAJOR && one.major < major)
    .sort((a, b) => b.major - a.major)[0];
  if (previous?.date === undefined) {
    return [
      refusal(
        `${input.version} is a major after v${WINDOW_OPENS_AT_MAJOR}, and docs/changelog/ has no dated \`## X.0.0 - YYYY-MM-DD\` section for a major from ${WINDOW_OPENS_AT_MAJOR}.0.0 below it, so the ${MAJOR_WINDOW_DAYS}-day window cannot be read`,
        undefined,
      ),
    ];
  }
  const opensOn = addDays(previous.date, MAJOR_WINDOW_DAYS);
  if (date >= opensOn) return [];
  if (security !== undefined) {
    if (ADVISORY_ID.test(security)) return [];
    return [
      refusal(
        `--security ${JSON.stringify(security)} is not a GitHub advisory or CVE id (GHSA-xxxx-xxxx-xxxx, CVE-YYYY-NNNN), so it cannot excuse ${input.version} inside the window`,
        opensOn,
      ),
    ];
  }
  return [
    refusal(
      `${input.version} on ${date} is ${daysBetween(previous.date, date)} day(s) after ${previous.version} (${previous.date}): at most one major per ${MAJOR_WINDOW_DAYS} days, and the next window opens on ${opensOn}`,
      opensOn,
    ),
  ];
}

/** The release's file text with the advisory recorded under `version`'s heading, exactly once. */
export function withSecurityException(
  text: string,
  version: string,
  id: string | undefined,
): string {
  const sections = parseChangelog(text);
  if (id === undefined || recordedException(sections, version) !== undefined) return text;
  const section = sections.find((one) => one.version === version);
  if (section === undefined) return text;
  const lines = text.split('\n');
  // `line` is 1-based, so it is the index of the line after the heading.
  lines.splice(section.line, 0, '', securityExceptionLine(id));
  return lines.join('\n');
}

/**
 * The bump's whole window question: `--security` names an advisory for a MAJOR, so on any other
 * bump it is a mistake refused by name rather than a line recorded for nothing.
 */
export function bumpWindowFindings(input: {
  readonly version: string;
  readonly changelog: Changelog;
  readonly today: string;
  readonly security: string | undefined;
}): readonly Finding[] {
  if (input.security !== undefined && !ADVISORY_ID.test(input.security)) {
    return [
      {
        code: 'X_CLI_BAD_FLAG',
        cause: `--security ${JSON.stringify(input.security)} is not a GitHub advisory or CVE id (GHSA-xxxx-xxxx-xxxx, CVE-YYYY-NNNN)`,
        fix: 'bun run scripts/release.ts --bump major --security GHSA-xxxx-xxxx-xxxx --dry-run --json   # the id from the published advisory',
        at: 'scripts/release.ts',
      },
    ];
  }
  if (input.security !== undefined && !opensMajorLine(input.version, input.changelog)) {
    return [
      {
        code: 'X_CLI_BAD_FLAG',
        cause: `--security excuses a major inside the window, and ${input.version} is not a major`,
        fix: 'bun run scripts/release.ts --bump patch --dry-run --json   # a security patch needs no exception',
        at: 'scripts/release.ts',
      },
    ];
  }
  return majorWindowFindings(input);
}

/** The report line a `--security` bump prints: where the advisory went, and what the commit owes. */
export const securityLines = (version: string, id: string | undefined): readonly string[] =>
  id === undefined
    ? []
    : [
        `  security  ${id} recorded under "## ${version}"; the commit body carries "Security-Exception: ${id}"`,
      ];

/** The bump's refusal, before a file moves; returns only when the window lets `version` through. */
export function refuseOutsideWindow(
  findings: readonly Finding[],
  data: { readonly version: string; readonly current: string },
  json: boolean,
): void {
  if (findings.length === 0) return;
  report(
    {
      ok: false,
      script: 'release',
      summary: `refusing to release ${data.version}: the major window refuses it (wiki/Stability.md)`,
      findings,
      data,
    },
    json,
  );
}
