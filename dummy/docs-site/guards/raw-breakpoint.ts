// raw-breakpoint: a viewport query names a rung of the one breakpoint ladder, never a width.
// `x verify` discovers every file in `guards/` and runs its `guard` inside the `boundaries`
// step — nothing registers this file, so nothing can forget to. Delete it to drop the rule.
//
// Only WIDTH queries are a breakpoint. `prefers-reduced-motion`, `prefers-color-scheme`, `print`,
// `hover` and a height query ask a different question and are never reported; a `@container`
// query sizes by the component and is the better tool, so it is not reported either.

import type { Finding, Guard } from '@ultimat3/cli';

/** The app owns the codes its own conventions raise — this one is named for the guard. */
const CODE = 'X_RAW_BREAKPOINT';

/** `@ultimat3/ui/tokens`' breakpoint ladder, in px. */
export const RUNGS: readonly (readonly [string, number])[] = [
  ['sm', 480],
  ['md', 768],
  ['lg', 1024],
  ['xl', 1280],
  ['2xl', 1536],
];

export interface StyleFile {
  /** App-root-relative POSIX path, so the finding names the file an author opens. */
  readonly path: string;
  readonly scss: string;
}

const blank = (text: string): string => text.replaceAll(/[^\n]/g, ' ');

/** Comments blanked rather than removed, so a reported line number still points at the source. */
const blankComments = (scss: string): string =>
  scss.replaceAll(/\/\*[\s\S]*?\*\//g, blank).replaceAll(/(?<![:\w])\/\/[^\n]*/g, blank);

const lineOf = (text: string, index: number): number => text.slice(0, index).split('\n').length;

/** The `as <name>` the token entry point is used under in this sheet; `tokens` when it is not. */
const namespaceOf = (scss: string): string =>
  /@use\s+['"][^'"]*tokens[^'"]*['"]\s+as\s+([\w-]+)/.exec(scss)?.[1] ?? 'tokens';

const MEDIA = /@media([^{;]*)/g;
/** `(min-width: …)`, `(max-width: …)`, and the range forms `(width >= …)` / `(… <= width)`. */
const WIDTH_FEATURE =
  /\(\s*(?:(?:min-|max-)?(?:width|inline-size)\s*[:<>=]|[^()]*[<>=]\s*(?:width|inline-size)\b)/;
const BOUND = /\(\s*(min|max)-(?:width|inline-size)\s*:\s*(\d*\.?\d+)(px|rem|em)\s*\)/g;

/** The rung a width means: exact where it is one, the nearest where it is not. */
const rungFor = (px: number): string => {
  let best = RUNGS[0];
  for (const rung of RUNGS) {
    if (best === undefined || Math.abs(rung[1] - px) < Math.abs(best[1] - px)) best = rung;
  }
  return best?.[0] ?? 'md';
};

/** The `@include` a hand-written width query is, where its bounds can be read. */
const includeFor = (prelude: string, ns: string): string | undefined => {
  let min: string | undefined;
  let max: string | undefined;
  for (const bound of prelude.matchAll(BOUND)) {
    const px = Number(bound[2]) * (bound[3] === 'px' ? 1 : 16);
    // A max-width is written just UNDER its rung (767px, 767.98px), so it rounds up to one.
    if (bound[1] === 'min') min = rungFor(px);
    else max = rungFor(Math.ceil(px + 0.5));
  }
  if (min !== undefined && max !== undefined) {
    return min === max ? undefined : `@include ${ns}.respond-between(${min}, ${max})`;
  }
  if (min !== undefined) return `@include ${ns}.respond-to(${min})`;
  if (max !== undefined) return `@include ${ns}.respond-down(${max})`;
  return undefined;
};

const SHADOWING = /@mixin\s+(respond-to|respond-down|respond-between)\b/g;

/** Pure — the caller does the I/O — so the rule is testable without a filesystem. */
export function rawBreakpoints(files: readonly StyleFile[]): readonly Finding[] {
  const findings: Finding[] = [];
  for (const file of files) {
    const scss = blankComments(file.scss);
    const ns = namespaceOf(file.scss);
    for (const match of scss.matchAll(SHADOWING)) {
      const line = lineOf(scss, match.index);
      findings.push({
        code: CODE,
        cause: `${file.path}:${line} defines its own ${match[1]} — @ultimat3/ui/tokens ships one, and a local definition silently shadows it, so the app has two breakpoint ladders`,
        fix: `delete @mixin ${match[1]} from ${file.path}:${line} and write @include ${ns}.${match[1]}(…), then: x verify`,
        at: `${file.path}:${line}`,
      });
    }
    for (const match of scss.matchAll(MEDIA)) {
      const prelude = match[1] ?? '';
      if (!WIDTH_FEATURE.test(prelude)) continue;
      const line = lineOf(scss, match.index);
      const include =
        includeFor(prelude, ns) ??
        `@include ${ns}.respond-to(<rung>), ${ns}.respond-down(<rung>) or ${ns}.respond-between(<from>, <to>) — rungs: ${RUNGS.map(([name]) => name).join(' ')}`;
      findings.push({
        code: CODE,
        cause: `${file.path}:${line} writes \`@media${prelude.trimEnd()}\` — a viewport width of its own, off the breakpoint ladder every other sheet shares`,
        fix: `${include} — at ${file.path}:${line}, then: x verify`,
        at: `${file.path}:${line}`,
      });
    }
  }
  return findings;
}

export const guard: Guard = {
  summary: 'a viewport query names a breakpoint rung, never a width',
  async check(_root, sources) {
    const sheets = await sources.files('{apps,packages}/**/*.scss');
    return rawBreakpoints(sheets.map((file) => ({ path: file.path, scss: file.text })));
  },
};
