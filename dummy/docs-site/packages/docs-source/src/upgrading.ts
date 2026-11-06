// `wiki/Upgrading.md` split: one page per `## N.x → M.0.0` major, at `/upgrading/M`, and an index
// holding everything else with a list of the majors where the first one stood. 380 KB as one page;
// split, "how do I move to 30" is one URL.

import type { WikiHeading } from '@ultimat3/manifest';
import { type Draft, type DraftLine, linesOf, sectionEnd } from './draft';

/** The major a `## 29.x → 30.0.0, entry by entry` heading moves TO; `undefined` for any other. */
export const majorOf = (heading: WikiHeading): number | undefined => {
  if (heading.level !== 2) return undefined;
  const found = /→\s*(\d+)\.0\.0\b/.exec(heading.heading)?.[1];
  return found === undefined ? undefined : Number(found);
};

export const majorUrl = (major: number): string => `/upgrading/${major}`;

export function splitUpgrading(
  file: string,
  lines: readonly string[],
  headings: readonly WikiHeading[],
  body: { readonly from: number; readonly title: string },
): { readonly index: Draft; readonly majors: readonly (Draft & { readonly major: number })[] } {
  const majors: (Draft & { readonly major: number })[] = [];
  const taken: { readonly from: number; readonly to: number }[] = [];
  headings.forEach((heading, index) => {
    const major = majorOf(heading);
    if (major === undefined) return;
    const to = sectionEnd(headings, index, lines.length);
    taken.push({ from: heading.line, to });
    majors.push({
      url: majorUrl(major),
      file,
      title: heading.heading,
      major,
      lines: linesOf(lines, heading.line + 1, to),
    });
  });
  const out: DraftLine[] = [];
  let listed = false;
  for (const line of linesOf(lines, body.from, lines.length)) {
    const inMajor = taken.find((range) => line.origin >= range.from && line.origin < range.to);
    if (inMajor === undefined) {
      out.push(line);
      continue;
    }
    if (listed) continue;
    listed = true;
    for (const major of majors)
      out.push({ text: `- [${major.title}](${major.url})`, origin: line.origin });
    out.push({ text: '', origin: line.origin });
  }
  return { index: { url: '/upgrading', file, title: body.title, lines: out }, majors };
}
