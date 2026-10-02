// The `raw-motion` guard `x new` ships: a duration and an easing curve are `tokens.duration()` and
// `tokens.easing()`. A literal `300ms` beside the scale's `220ms` is two tempos in one app, and
// nothing but this reads a stylesheet for it.

import { guardCode } from './guard';
import type { GeneratedFile } from './naming';

/** Derived from the guard's name, never a literal: an `X_*` literal here is a FRAMEWORK code. */
const NAME = 'raw-motion';
const CODE = guardCode(NAME);

const source =
  (): string => `// raw-motion: every duration and curve comes off the motion scale, so the app moves at one tempo.
// \`x verify\` discovers every file in \`guards/\` and runs its \`guard\` inside the \`boundaries\`
// step — nothing registers this file, so nothing can forget to. Delete it to drop the rule.
//
// A keyword is not a literal: \`linear\`, \`ease\`, \`infinite\` and \`0s\` are never reported, and a
// multiple of a token is still the token — \`calc(#{tokens.duration(slower)} * 2)\`.

import type { Finding, Guard } from '@ultimat3/cli';

/** The app owns the codes its own conventions raise — this one is named for the guard. */
const CODE = '${CODE}';

/** \`@ultimat3/ui/tokens\`' duration scale, in ms. */
export const DURATIONS: readonly (readonly [string, number])[] = [
  ['instant', 0],
  ['fast', 120],
  ['base', 220],
  ['slow', 400],
  ['slower', 640],
];
/** \`@ultimat3/ui/tokens\`' easing curves, as the control points each one is. */
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

const blank = (text: string): string => text.replaceAll(/[^\\n]/g, ' ');

/** Comments blanked rather than removed, so a reported line number still points at the source. */
const blankComments = (scss: string): string =>
  scss.replaceAll(/\\/\\*[\\s\\S]*?\\*\\//g, blank).replaceAll(/(?<![:\\w])\\/\\/[^\\n]*/g, blank);

const lineOf = (text: string, index: number): number => text.slice(0, index).split('\\n').length;

/** The \`as <name>\` the token entry point is used under in this sheet; \`tokens\` when it is not. */
const namespaceOf = (scss: string): string =>
  /@use\\s+['"][^'"]*tokens[^'"]*['"]\\s+as\\s+([\\w-]+)/.exec(scss)?.[1] ?? 'tokens';

/** A declaration; a Sass \`#{…}\` interpolation is a value that carries braces. */
const DECLARATION = /(?<![\\w$-])([\\w-]+)\\s*:\\s*((?:#\\{[^}]*\\}|[^;{}])+)/g;
const MOTION_PROPERTY = /^(?:transition|animation)(?:-|$)/;
/** A token read, with its argument list: \`tokens.duration(fast)\`, \`var(--duration-fast)\`. */
const TOKEN_CALL = /(?<![\\w-])(?:var|(?:[\\w-]+\\.)[\\w-]+|duration|easing)\\([^()]*\\)/g;
const TIME = /(?<![\\w.#-])(\\d*\\.?\\d+)(ms|s)\\b/g;
const CURVE = /cubic-bezier\\(([^)]*)\\)/g;

/** The step a duration means: exact where it is one, the nearest where it is not. */
const durationFor = (ms: number): string => {
  let best: readonly [string, number] | undefined;
  for (const step of DURATIONS) {
    // \`instant\` is no motion at all; a time someone wrote is never repaired to nothing.
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
      const value = (match[2] ?? '').trim().replaceAll(/\\s+/g, ' ');
      const read = value.replaceAll(TOKEN_CALL, (call) => ' '.repeat(call.length));
      const literals: string[] = [];
      let written = '';
      let cursor = 0;
      const rewrite = (index: number, length: number, replacement: string): void => {
        written += value.slice(cursor, index) + replacement;
        cursor = index + length;
      };
      // Offsets in \`read\` are offsets in \`value\`: a token call is blanked, never removed.
      const hits = [
        ...[...read.matchAll(CURVE)].map((curve) => ({
          index: curve.index,
          text: curve[0],
          token: \`\${ns}.easing(\${EASINGS[(curve[1] ?? '').replaceAll(/\\s+/g, '')] ?? 'out'})\`,
        })),
        ...[...read.replaceAll(CURVE, (curve) => ' '.repeat(curve.length)).matchAll(TIME)]
          .filter((time) => Number(time[1]) !== 0)
          .map((time) => ({
            index: time.index,
            text: time[0],
            token: \`\${ns}.duration(\${durationFor(Number(time[1]) * (time[2] === 's' ? 1000 : 1))})\`,
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
        cause: \`\${file.path}:\${line} writes \\\`\${property}: \${value}\\\` — \${literals.join(' and ')} off the motion scale, a tempo of this file's own\`,
        fix: \`\${property}: \${written} — at \${file.path}:\${line} (durations: \${DURATIONS.map(([name]) => name).join(' ')}; a longer one is calc(#{\${ns}.duration(slower)} * 2)), then: x verify\`,
        at: \`\${file.path}:\${line}\`,
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
`;

const test =
  (): string => `// The rule, driven directly. Failure case first: a guard whose rule silently stopped matching is
// a green gate over the convention it was written to enforce.

import { expect, unitTest } from '@ultimat3/testing';
import { rawMotion } from './raw-motion';

const sheet = (scss: string) => [{ path: 'apps/web/site/page.module.scss', scss }];
const fixes = (scss: string) => rawMotion(sheet(scss)).map((finding) => finding.fix);

unitTest('a duration literal is refused, and the fix is the declaration to write', () => {
  const findings = rawMotion(sheet('.a {\\n  transition: opacity 120ms ease;\\n}\\n'));
  expect(findings).toHaveLength(1);
  expect(findings[0]?.code).toBe('${CODE}');
  expect(findings[0]?.at).toBe('apps/web/site/page.module.scss:2');
  expect(findings[0]?.fix).toStartWith('transition: opacity tokens.duration(fast) ease — ');
});

unitTest('seconds are read as milliseconds, and a time off the scale gets the nearest step', () => {
  expect(fixes('.a { animation-duration: 0.4s; }')[0]).toStartWith(
    'animation-duration: tokens.duration(slow) — ',
  );
  expect(fixes('.a { transition-duration: 300ms; }')[0]).toStartWith(
    'transition-duration: tokens.duration(base) — ',
  );
  expect(fixes('.a { animation: spin 2.4s linear infinite; }')[0]).toStartWith(
    'animation: spin tokens.duration(slower) linear infinite — ',
  );
});

unitTest('a cubic-bezier is refused, and one that IS a token is named', () => {
  expect(
    fixes('.a { transition: opacity tokens.duration(fast) cubic-bezier(0.16, 1, 0.3, 1); }')[0],
  ).toStartWith('transition: opacity tokens.duration(fast) tokens.easing(out) — ');
  expect(
    rawMotion(sheet('.a { animation-timing-function: cubic-bezier(0.2, 0, 0, 1); }')),
  ).toHaveLength(1);
});

unitTest('one declaration is one finding, with every literal in it rewritten', () => {
  const findings = rawMotion(
    sheet('.a { transition: color 220ms cubic-bezier(0.65, 0, 0.35, 1), opacity 640ms ease; }'),
  );
  expect(findings).toHaveLength(1);
  expect(findings[0]?.fix).toStartWith(
    'transition: color tokens.duration(base) tokens.easing(in-out), opacity tokens.duration(slower) ease — ',
  );
});

unitTest('the fix speaks the namespace the sheet uses the tokens under', () => {
  const scss = "@use '../shared/tokens' as t;\\n.a { transition-duration: 120ms; }";
  expect(fixes(scss)[0]).toStartWith('transition-duration: t.duration(fast) — ');
});

// The legitimate lookalikes — the reason the rule can stay switched on.
unitTest('a token, a keyword, a zero and a multiple of a token are silent', () => {
  const silent = [
    '.a { transition: opacity tokens.duration(fast) tokens.easing(out); }',
    '.a { transition: opacity var(--duration-fast) var(--easing-out); }',
    '.a { animation: spin calc(#{tokens.duration(slower)} * 2) linear infinite; }',
    '.a { transition: none; }',
    '.a { transition-delay: 0s; animation-delay: 0ms; }',
    '.a { animation-iteration-count: 3; }',
    '// transition: opacity 120ms;\\n.a { transition: none; }',
    '.a { width: 100ms; }',
    '$tempo: 120ms;',
  ];
  for (const scss of silent) expect(rawMotion(sheet(scss))).toEqual([]);
});
`;

/** `guards/raw-motion.ts` and its test. No index, no registry — the directory is the registration. */
export const rawMotionGuardFiles = (): readonly GeneratedFile[] => [
  { path: `guards/${NAME}.ts`, contents: source() },
  { path: `guards/${NAME}.test.ts`, contents: test() },
];
