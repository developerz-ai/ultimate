// The `raw-breakpoint` guard `x new` ships: a viewport query is `respond-to` / `respond-down` /
// `respond-between` over the one ladder, never a hand-written `@media (min-width: …)`. It also
// refuses a local `@mixin respond-*`: Sass lets a sheet that forwards the tokens redefine one with
// no error, which is how an app ends up with two breakpoint ladders and nothing saying so.

import { guardCode } from './guard';
import type { GeneratedFile } from './naming';

/** Derived from the guard's name, never a literal: an `X_*` literal here is a FRAMEWORK code. */
const NAME = 'raw-breakpoint';
const CODE = guardCode(NAME);

const source =
  (): string => `// raw-breakpoint: a viewport query names a rung of the one breakpoint ladder, never a width.
// \`x verify\` discovers every file in \`guards/\` and runs its \`guard\` inside the \`boundaries\`
// step — nothing registers this file, so nothing can forget to. Delete it to drop the rule.
//
// Only WIDTH queries are a breakpoint. \`prefers-reduced-motion\`, \`prefers-color-scheme\`, \`print\`,
// \`hover\` and a height query ask a different question and are never reported; a \`@container\`
// query sizes by the component and is the better tool, so it is not reported either.

import type { Finding, Guard } from '@ultimat3/cli';

/** The app owns the codes its own conventions raise — this one is named for the guard. */
const CODE = '${CODE}';

/** \`@ultimat3/ui/tokens\`' breakpoint ladder, in px. */
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

const blank = (text: string): string => text.replaceAll(/[^\\n]/g, ' ');

/** Comments blanked rather than removed, so a reported line number still points at the source. */
const blankComments = (scss: string): string =>
  scss.replaceAll(/\\/\\*[\\s\\S]*?\\*\\//g, blank).replaceAll(/(?<![:\\w])\\/\\/[^\\n]*/g, blank);

const lineOf = (text: string, index: number): number => text.slice(0, index).split('\\n').length;

/** The \`as <name>\` the token entry point is used under in this sheet; \`tokens\` when it is not. */
const namespaceOf = (scss: string): string =>
  /@use\\s+['"][^'"]*tokens[^'"]*['"]\\s+as\\s+([\\w-]+)/.exec(scss)?.[1] ?? 'tokens';

const MEDIA = /@media([^{;]*)/g;
/** \`(min-width: …)\`, \`(max-width: …)\`, and the range forms \`(width >= …)\` / \`(… <= width)\`. */
const WIDTH_FEATURE =
  /\\(\\s*(?:(?:min-|max-)?(?:width|inline-size)\\s*[:<>=]|[^()]*[<>=]\\s*(?:width|inline-size)\\b)/;
const BOUND = /\\(\\s*(min|max)-(?:width|inline-size)\\s*:\\s*(\\d*\\.?\\d+)(px|rem|em)\\s*\\)/g;

/** The rung a width means: exact where it is one, the nearest where it is not. */
const rungFor = (px: number): string => {
  let best = RUNGS[0];
  for (const rung of RUNGS) {
    if (best === undefined || Math.abs(rung[1] - px) < Math.abs(best[1] - px)) best = rung;
  }
  return best?.[0] ?? 'md';
};

/** The \`@include\` a hand-written width query is, where its bounds can be read. */
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
    return min === max ? undefined : \`@include \${ns}.respond-between(\${min}, \${max})\`;
  }
  if (min !== undefined) return \`@include \${ns}.respond-to(\${min})\`;
  if (max !== undefined) return \`@include \${ns}.respond-down(\${max})\`;
  return undefined;
};

const SHADOWING = /@mixin\\s+(respond-to|respond-down|respond-between)\\b/g;

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
        cause: \`\${file.path}:\${line} defines its own \${match[1]} — @ultimat3/ui/tokens ships one, and a local definition silently shadows it, so the app has two breakpoint ladders\`,
        fix: \`delete @mixin \${match[1]} from \${file.path}:\${line} and write @include \${ns}.\${match[1]}(…), then: x verify\`,
        at: \`\${file.path}:\${line}\`,
      });
    }
    for (const match of scss.matchAll(MEDIA)) {
      const prelude = match[1] ?? '';
      if (!WIDTH_FEATURE.test(prelude)) continue;
      const line = lineOf(scss, match.index);
      const include =
        includeFor(prelude, ns) ??
        \`@include \${ns}.respond-to(<rung>), \${ns}.respond-down(<rung>) or \${ns}.respond-between(<from>, <to>) — rungs: \${RUNGS.map(([name]) => name).join(' ')}\`;
      findings.push({
        code: CODE,
        cause: \`\${file.path}:\${line} writes \\\`@media\${prelude.trimEnd()}\\\` — a viewport width of its own, off the breakpoint ladder every other sheet shares\`,
        fix: \`\${include} — at \${file.path}:\${line}, then: x verify\`,
        at: \`\${file.path}:\${line}\`,
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
`;

const test =
  (): string => `// The rule, driven directly. Failure case first: a guard whose rule silently stopped matching is
// a green gate over the convention it was written to enforce.

import { expect, unitTest } from '@ultimat3/testing';
import { rawBreakpoints } from './raw-breakpoint';

const sheet = (scss: string) => [{ path: 'apps/web/site/page.module.scss', scss }];
const fixes = (scss: string) => rawBreakpoints(sheet(scss)).map((finding) => finding.fix);

unitTest('a hand-written min-width is refused, and the fix is the include to write', () => {
  const findings = rawBreakpoints(
    sheet('.a {\\n  @media (min-width: 768px) {\\n    gap: 0;\\n  }\\n}\\n'),
  );
  expect(findings).toHaveLength(1);
  expect(findings[0]?.code).toBe('${CODE}');
  expect(findings[0]?.at).toBe('apps/web/site/page.module.scss:2');
  expect(findings[0]?.fix).toStartWith('@include tokens.respond-to(md) — ');
});

unitTest('a max-width just under a rung is respond-down of that rung', () => {
  expect(fixes('@media (max-width: 767px) { .a { gap: 0; } }')[0]).toStartWith(
    '@include tokens.respond-down(md) — ',
  );
  expect(fixes('@media (max-width: 767.98px) { .a { gap: 0; } }')[0]).toStartWith(
    '@include tokens.respond-down(md) — ',
  );
});

unitTest(
  'both bounds are respond-between, and a width off the ladder gets the nearest rung',
  () => {
    const both = '@media screen and (min-width: 48em) and (max-width: 1023px) { .a { gap: 0; } }';
    expect(fixes(both)[0]).toStartWith('@include tokens.respond-between(md, lg) — ');
    expect(fixes('@media (min-width: 800px) { .a { gap: 0; } }')[0]).toStartWith(
      '@include tokens.respond-to(md) — ',
    );
  },
);

unitTest('the range syntax is the same query, and names the three mixins', () => {
  const findings = rawBreakpoints(sheet('@media (width >= 768px) { .a { gap: 0; } }'));
  expect(findings).toHaveLength(1);
  expect(findings[0]?.fix).toContain('tokens.respond-between(<from>, <to>)');
});

unitTest('the fix speaks the namespace the sheet uses the tokens under', () => {
  const scss = "@use '../shared/tokens' as t;\\n@media (min-width: 1024px) { .a { gap: 0; } }";
  expect(fixes(scss)[0]).toStartWith('@include t.respond-to(lg) — ');
});

// The legitimate lookalikes — the reason the rule can stay switched on.
unitTest('a query that is not about the viewport width is not a breakpoint', () => {
  const silent = [
    '@media (prefers-reduced-motion: no-preference) { .a { gap: 0; } }',
    '@media (prefers-color-scheme: dark) { .a { gap: 0; } }',
    '@media print { .a { gap: 0; } }',
    '@media (hover: hover) and (min-height: 600px) { .a { gap: 0; } }',
    '@container card (min-width: 30rem) { .a { gap: 0; } }',
    '.a { @include tokens.respond-to(md) { gap: 0; } }',
    '// @media (min-width: 768px) {}\\n.a { gap: 0; }',
  ];
  for (const scss of silent) expect(rawBreakpoints(sheet(scss))).toEqual([]);
});

unitTest('a local respond-* mixin shadows the framework one, and is refused', () => {
  const findings = rawBreakpoints(sheet('@mixin respond-down($bp) {\\n  @content;\\n}\\n'));
  expect(findings).toHaveLength(1);
  expect(findings[0]?.cause).toContain('defines its own respond-down');
  expect(findings[0]?.fix).toStartWith(
    'delete @mixin respond-down from apps/web/site/page.module.scss:1',
  );
});
`;

/** `guards/raw-breakpoint.ts` and its test. No index, no registry — the directory is the registration. */
export const rawBreakpointGuardFiles = (): readonly GeneratedFile[] => [
  { path: `guards/${NAME}.ts`, contents: source() },
  { path: `guards/${NAME}.test.ts`, contents: test() },
];
