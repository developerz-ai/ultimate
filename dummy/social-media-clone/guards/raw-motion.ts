// raw-motion: every duration and curve comes off the motion scale, so the app moves at one tempo.
// `x verify` discovers every file in `guards/` and runs its `guard` inside the `boundaries`
// step — nothing registers this file, so nothing can forget to. Delete it to drop the rule.
//
// A keyword is not a literal: `linear`, `ease`, `infinite` and `0s` are never reported, and a
// multiple of a token is still the token — `calc(#{tokens.duration(slower)} * 2)`.

import type { Finding, Guard } from '@ultimat3/cli';

/** The app owns the codes its own conventions raise — this one is named for the guard. */
const CODE = 'X_RAW_MOTION';

/** `@ultimat3/ui/tokens`' duration scale, in ms. */
export const DURATIONS: readonly (readonly [string, number])[] = [
  ['instant', 0],
  ['fast', 120],
  ['base', 220],
  ['slow', 400],
  ['slower', 640],
];
/** `@ultimat3/ui/tokens`' easing curves, as the control points each one is. */
export const EASINGS: Readonly<Record<string, string>> = {
  '0.16,1,0.3,1': 'out',
  '0.5,0,0.75,0': 'in',
  '0.65,0,0.35,1': 'in-out',
  '0.34,1.56,0.64,1': 'spring',
};

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

/** A declaration; a Sass `#{…}` interpolation is a value that carries braces. */
const DECLARATION = /(?<![\w$-])([\w-]+)\s*:\s*((?:#\{[^}]*\}|[^;{}])+)/g;
const MOTION_PROPERTY = /^(?:transition|animation)(?:-|$)/;
/** A token read, with its argument list: `tokens.duration(fast)`, `var(--duration-fast)`. */
const TOKEN_CALL = /(?<![\w-])(?:var|(?:[\w-]+\.)[\w-]+|duration|easing)\([^()]*\)/g;
const TIME = /(?<![\w.#-])(\d*\.?\d+)(ms|s)\b/g;
const CURVE = /cubic-bezier\(([^)]*)\)/g;

/** The step a duration means: exact where it is one, the nearest where it is not. */
const durationFor = (ms: number): string => {
  let best: readonly [string, number] | undefined;
  for (const step of DURATIONS) {
    // `instant` is no motion at all; a time someone wrote is never repaired to nothing.
    if (step[1] === 0) continue;
    if (best === undefined || Math.abs(step[1] - ms) < Math.abs(best[1] - ms)) best = step;
  }
  return best?.[0] ?? 'base';
};

/** Pure — the caller does the I/O — so the rule is testable without a filesystem. */
export function rawMotion(files: readonly StyleFile[]): readonly Finding[] {
  const findings: Finding[] = [];
  for (const file of files) {
    const scss = blankComments(file.scss);
    const ns = namespaceOf(file.scss);
    for (const match of scss.matchAll(DECLARATION)) {
      const property = match[1] ?? '';
      if (!MOTION_PROPERTY.test(property)) continue;
      const value = (match[2] ?? '').trim().replaceAll(/\s+/g, ' ');
      const read = value.replaceAll(TOKEN_CALL, (call) => ' '.repeat(call.length));
      const literals: string[] = [];
      let written = '';
      let cursor = 0;
      const rewrite = (index: number, length: number, replacement: string): void => {
        written += value.slice(cursor, index) + replacement;
        cursor = index + length;
      };
      // Offsets in `read` are offsets in `value`: a token call is blanked, never removed.
      const hits = [
        ...[...read.matchAll(CURVE)].map((curve) => ({
          index: curve.index,
          text: curve[0],
          token: `${ns}.easing(${EASINGS[(curve[1] ?? '').replaceAll(/\s+/g, '')] ?? 'out'})`,
        })),
        ...[...read.replaceAll(CURVE, (curve) => ' '.repeat(curve.length)).matchAll(TIME)]
          .filter((time) => Number(time[1]) !== 0)
          .map((time) => ({
            index: time.index,
            text: time[0],
            token: `${ns}.duration(${durationFor(Number(time[1]) * (time[2] === 's' ? 1000 : 1))})`,
          })),
      ].sort((a, b) => a.index - b.index);
      for (const hit of hits) {
        literals.push(hit.text);
        rewrite(hit.index, hit.text.length, hit.token);
      }
      if (literals.length === 0) continue;
      written += value.slice(cursor);
      const line = lineOf(scss, match.index);
      findings.push({
        code: CODE,
        cause: `${file.path}:${line} writes \`${property}: ${value}\` — ${literals.join(' and ')} off the motion scale, a tempo of this file's own`,
        fix: `${property}: ${written} — at ${file.path}:${line} (durations: ${DURATIONS.map(([name]) => name).join(' ')}; a longer one is calc(#{${ns}.duration(slower)} * 2)), then: x verify`,
        at: `${file.path}:${line}`,
      });
    }
  }
  return findings;
}

export const guard: Guard = {
  summary: 'a duration and an easing curve come off the motion scale, never a literal',
  async check(_root, sources) {
    const sheets = await sources.files('{apps,packages}/**/*.scss');
    return rawMotion(sheets.map((file) => ({ path: file.path, scss: file.text })));
  },
};
