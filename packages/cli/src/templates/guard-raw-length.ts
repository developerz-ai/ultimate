// The `raw-length` guard `x new` ships: no stylesheet and no inline style in this app writes a px.
// Until it existed only raw COLOUR was a build error; `padding: 12px` beside `tokens.space(3)` was
// green on `x verify`, and one surveyed app carried 870 off-scale lengths from before its own rule.
// The same file refuses a local `@function rem` / `fluid`, which silently shadows the framework's.

import { guardCode } from './guard';
import type { GeneratedFile } from './naming';

/** Derived from the guard's name, never a literal: an `X_*` literal here is a FRAMEWORK code. */
const NAME = 'raw-length';
const CODE = guardCode(NAME);

const source =
  (): string => `// raw-length: every length in this app comes off the scale, so a layout holds at 200% text zoom.
// \`x verify\` discovers every file in \`guards/\` and runs its \`guard\` inside the \`boundaries\`
// step — nothing registers this file, so nothing can forget to. Delete it to drop the rule.
//
// A DEFINITION is not a use: \`$gutter: 12px\`, a map entry and a parameter default name a value in
// one place, which is what a token is, and are never reported. What is reported is a px literal
// written where a property, an \`@include\` or an inline \`style\` takes its value.

import type { Finding, Guard } from '@ultimat3/cli';

/** The app owns the codes its own conventions raise — this one is named for the guard. */
const CODE = '${CODE}';

/** px → the step of \`@ultimat3/ui/tokens\`' space scale that IS that length. */
export const SPACE: Readonly<Record<string, string>> = {
  '4': '1',
  '8': '2',
  '12': '3',
  '16': '4',
  '20': '5',
  '24': '6',
  '32': '8',
  '40': '10',
  '48': '12',
  '64': '16',
};
/** px → the rung of the stroke scale: a border, an outline, a focus ring. */
export const STROKE: Readonly<Record<string, string>> = { '2': 'thick', '3': 'heavy' };
/** The properties a stroke is written in. Anywhere else 2px is a length, not a line weight. */
const STROKED = /^(?:border|outline|column-rule|text-decoration-thickness|stroke-width)/;
/** Owned by \`raw-shadow\`, which reads the whole value: one line, one finding. */
const SHADOWED = /^(?:box-shadow|text-shadow)$/;

export interface StyleFile {
  /** App-root-relative POSIX path, so the finding names the file an author opens. */
  readonly path: string;
  readonly scss: string;
}

export interface MarkupFile {
  readonly path: string;
  readonly tsx: string;
}

const blank = (text: string): string => text.replaceAll(/[^\\n]/g, ' ');

/**
 * Comments blanked rather than removed, so a reported line number still points at the source
 * line. \`//\` is skipped when a \`:\` precedes it — \`url(https://…)\` is a value.
 */
const blankComments = (scss: string): string =>
  scss.replaceAll(/\\/\\*[\\s\\S]*?\\*\\//g, blank).replaceAll(/(?<![:\\w])\\/\\/[^\\n]*/g, blank);

/** Quoted text is a filename or a token name, never a length: \`url('hero-640px.png')\`. */
const blankQuoted = (scss: string): string => scss.replaceAll(/'[^'\\n]*'|"[^"\\n]*"/g, blank);

/** The index just past the \`)\` that closes the \`(\` at \`open\`, or \`undefined\` when none does. */
const closeOf = (text: string, open: number): number | undefined => {
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    const character = text.charAt(index);
    if (character === '(') depth += 1;
    else if (character === ')') {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return undefined;
};

/** Every balanced \`(…)\` opened by a match of \`opener\` (which must END at the \`(\`), blanked. */
const blankCalls = (text: string, opener: RegExp): string => {
  let out = text;
  for (const match of text.matchAll(opener)) {
    const open = match.index + match[0].length - 1;
    const close = closeOf(out, open);
    if (close !== undefined)
      out = out.slice(0, open) + blank(out.slice(open, close)) + out.slice(close);
  }
  return out;
};

/** \`$name: …;\` at the start of a statement — a definition, map bodies included. */
const VARIABLE = /(?<=(?:^|[{};])\\s*)\\$[\\w-]+\\s*:[^;]*;/g;
/** The parameter list of a \`@mixin\` / \`@function\`: its defaults are definitions too. */
const PARAMETERS = /@(?:mixin|function)\\s+[\\w-]+\\s*\\(/g;
/** \`rem(24px)\` and \`fluid(16px, 32px)\` are how an off-scale length is written. */
const CONVERSION = /(?<![\\w-])(?:[\\w-]+\\.)?(?:rem|fluid)\\(/g;
/** A viewport query is \`raw-breakpoint\`'s line. */
const MEDIA = /@media[^{]*/g;

/** \`#{…}\` is a value that carries braces; as parentheses it no longer ends a statement. */
const INTERPOLATION = /#\\{([^}]*)\\}/g;

/** What is left is every place a length is USED. Same length as the source, offset for offset. */
const usesOf = (scss: string): string =>
  blankCalls(
    blankCalls(
      blankQuoted(blankComments(scss))
        .replaceAll(INTERPOLATION, (_match, inner: string) => \`#(\${inner})\`)
        .replaceAll(VARIABLE, blank),
      PARAMETERS,
    ),
    CONVERSION,
  ).replaceAll(MEDIA, blank);

/** A px literal: signed, and never the tail of a name (\`.gap-12px\`) or a hex (\`#12px\`). */
const PX = /(?<=[\\s(,:/*+]-?)(\\d*\\.?\\d+)px\\b/g;

const lineOf = (text: string, index: number): number => text.slice(0, index).split('\\n').length;

/** The \`as <name>\` the token entry point is used under in this sheet; \`tokens\` when it is not. */
const namespaceOf = (scss: string): string =>
  /@use\\s+['"][^'"]*tokens[^'"]*['"]\\s+as\\s+([\\w-]+)/.exec(scss)?.[1] ?? 'tokens';

/** The statement around \`index\` — from the \`;\`, \`{\` or \`}\` before it to the one after. */
const statementAt = (
  text: string,
  index: number,
): { readonly start: number; readonly end: number } => {
  let start = index;
  while (start > 0 && !';{}'.includes(text.charAt(start - 1))) start -= 1;
  let end = index;
  while (end < text.length && !';{}'.includes(text.charAt(end))) end += 1;
  return { start, end };
};

/** What \`<n>px\` is written as: a step of the scale where it is one, \`rem()\` where it is not. */
const tokenFor = (px: string, negative: boolean, property: string, ns: string): string => {
  const stroke = STROKED.test(property) ? STROKE[px] : undefined;
  const call =
    stroke !== undefined
      ? \`\${ns}.stroke(\${stroke})\`
      : SPACE[px] !== undefined
        ? \`\${ns}.space(\${SPACE[px]})\`
        : undefined;
  if (call === undefined) return \`\${ns}.rem(\${negative ? '-' : ''}\${px}px)\`;
  return negative ? \`calc(-1 * #{\${call}})\` : call;
};

const SHADOWING = /@function\\s+(rem|fluid)\\s*\\(/g;

/** Pure — the caller does the I/O — so the rule is testable without a filesystem. */
export function rawLengths(files: readonly StyleFile[]): readonly Finding[] {
  const findings: Finding[] = [];
  for (const file of files) {
    const ns = namespaceOf(file.scss);
    const commentless = blankComments(file.scss);
    for (const match of commentless.matchAll(SHADOWING)) {
      const line = lineOf(commentless, match.index);
      findings.push({
        code: CODE,
        cause: \`\${file.path}:\${line} defines its own \${match[1]}() — @ultimat3/ui/tokens ships one, and a local definition silently shadows it, so two sheets can disagree about what a px is\`,
        fix: \`delete @function \${match[1]} from \${file.path}:\${line} and call \${ns}.\${match[1]}(), then: x verify\`,
        at: \`\${file.path}:\${line}\`,
      });
    }

    const uses = usesOf(file.scss);
    const reported = new Set<number>();
    for (const match of uses.matchAll(PX)) {
      if (Number(match[1]) === 1 || Number(match[1]) === 0) continue;
      const { start, end } = statementAt(uses, match.index);
      if (reported.has(start)) continue;
      const statement = commentless.slice(start, end).trim().replaceAll(/\\s+/g, ' ');
      const property = /^([\\w-]+)\\s*:/.exec(statement)?.[1] ?? '';
      if (SHADOWED.test(property)) continue;
      reported.add(start);
      // Rewritten from the BLANKED statement's matches, so a px inside \`rem(…)\` or a quoted
      // filename in the same statement is left exactly as written.
      let rewritten = '';
      let cursor = start;
      for (const literal of uses.slice(start, end).matchAll(PX)) {
        if (Number(literal[1]) === 1 || Number(literal[1]) === 0) continue;
        const at = start + literal.index;
        const negative = uses.charAt(at - 1) === '-';
        rewritten += commentless.slice(cursor, negative ? at - 1 : at);
        rewritten += tokenFor(literal[1] ?? '', negative, property, ns);
        cursor = at + literal[0].length;
      }
      rewritten = (rewritten + commentless.slice(cursor, end)).trim().replaceAll(/\\s+/g, ' ');
      const line = lineOf(uses, match.index);
      findings.push({
        code: CODE,
        cause: \`\${file.path}:\${line} writes \\\`\${statement}\\\` — a px length off the scale: it does not grow with the reader's text size, and no token names it\`,
        fix: \`\${rewritten} — at \${file.path}:\${line}, then: x verify\`,
        at: \`\${file.path}:\${line}\`,
      });
    }
  }
  return findings;
}

/** \`style={{ … }}\`, \`style="…"\` and \`style={\`…\`}\` — the three ways markup carries a length. */
const INLINE_STYLE = /\\bstyle=(?:\\{\\{([\\s\\S]*?)\\}\\}|"([^"]*)"|\\{\`([^\`]*)\`\\})/g;
const INLINE_PX = /(?<![\\w.#-])(\\d*\\.?\\d+)px\\b/g;

/** The same rule for markup: an inline \`style\` is a stylesheet nobody lints. */
export function rawInlineLengths(files: readonly MarkupFile[]): readonly Finding[] {
  const findings: Finding[] = [];
  for (const file of files) {
    for (const style of file.tsx.matchAll(INLINE_STYLE)) {
      const body = style[1] ?? style[2] ?? style[3] ?? '';
      for (const literal of body.matchAll(INLINE_PX)) {
        const px = literal[1] ?? '';
        if (Number(px) === 1 || Number(px) === 0) continue;
        const line = lineOf(file.tsx, style.index);
        const step = SPACE[px];
        const written = step === undefined ? \`\${Number(px) / 16}rem\` : \`var(--space-\${step})\`;
        findings.push({
          code: CODE,
          cause: \`\${file.path}:\${line} sets \${px}px in an inline style — a length off the scale, in the one stylesheet nothing else reads\`,
          fix: \`\${written} in place of \${px}px — at \${file.path}:\${line}; better, move the declaration into the element's .module.scss, then: x verify\`,
          at: \`\${file.path}:\${line}\`,
        });
      }
    }
  }
  return findings;
}

export const guard: Guard = {
  summary: 'a length is a token or rem(), never a raw px',
  async check(_root, sources) {
    const sheets = await sources.files('{apps,packages}/**/*.scss');
    const markup = await sources.files('{apps,packages}/**/*.tsx');
    return [
      ...rawLengths(sheets.map((file) => ({ path: file.path, scss: file.text }))),
      ...rawInlineLengths(markup.map((file) => ({ path: file.path, tsx: file.text }))),
    ];
  },
};
`;

const test =
  (): string => `// The rule, driven directly. Failure case first: a guard whose rule silently stopped matching is
// a green gate over the convention it was written to enforce.

import { expect, unitTest } from '@ultimat3/testing';
import { rawInlineLengths, rawLengths } from './raw-length';

const sheet = (scss: string) => [{ path: 'apps/web/site/page.module.scss', scss }];
const fixes = (scss: string) => rawLengths(sheet(scss)).map((finding) => finding.fix);

unitTest('a px on the space scale is refused, and the fix is the declaration to write', () => {
  const findings = rawLengths(sheet('.hero {\\n  padding: 12px;\\n}\\n'));
  expect(findings).toHaveLength(1);
  expect(findings[0]?.code).toBe('${CODE}');
  expect(findings[0]?.at).toBe('apps/web/site/page.module.scss:2');
  expect(findings[0]?.cause).toContain('padding: 12px');
  expect(findings[0]?.fix).toStartWith('padding: tokens.space(3) — ');
});

unitTest('a px off the scale is written through rem()', () => {
  expect(fixes('.a { font-size: 14px; }')[0]).toStartWith('font-size: tokens.rem(14px) — ');
});

unitTest('one statement is one finding, with every literal in it rewritten', () => {
  const findings = rawLengths(sheet('.a { margin: 8px 14px -16px; }'));
  expect(findings).toHaveLength(1);
  expect(findings[0]?.fix).toStartWith(
    'margin: tokens.space(2) tokens.rem(14px) calc(-1 * #{tokens.space(4)}) — ',
  );
});

unitTest('the fix speaks the namespace the sheet uses the tokens under', () => {
  const scss = "@use '../../shared/tokens' as t;\\n.a { gap: 8px; }";
  expect(fixes(scss)[0]).toStartWith('gap: t.space(2) — ');
});

unitTest('a line weight is a stroke, not a space step', () => {
  expect(fixes('.a { border: 2px solid currentcolor; }')[0]).toStartWith(
    'border: tokens.stroke(thick) solid currentcolor — ',
  );
  expect(fixes('.a { outline-offset: -3px; }')[0]).toStartWith(
    'outline-offset: calc(-1 * #{tokens.stroke(heavy)}) — ',
  );
});

unitTest('an @include argument is a use', () => {
  expect(fixes('.a { @include tokens.focus-ring(accent, 4px); }')[0]).toStartWith(
    '@include tokens.focus-ring(accent, tokens.space(1)) — ',
  );
});

unitTest('a hairline and a zero are not lengths anyone scales', () => {
  expect(rawLengths(sheet('.a { border: 1px solid; margin: -1px; inset: 0px; }'))).toEqual([]);
});

// The legitimate lookalikes — the reason the rule can stay switched on.
unitTest('a px handed to rem() or fluid() is the sanctioned spelling', () => {
  expect(rawLengths(sheet('.a { width: tokens.rem(340px); }'))).toEqual([]);
  expect(rawLengths(sheet('.a { font-size: tokens.fluid(16px, 32px); }'))).toEqual([]);
  expect(rawLengths(sheet('.a { margin: calc(-1 * #{tokens.rem(6px)}) 0; }'))).toEqual([]);
});

unitTest('a definition names a value in one place, and is not a use', () => {
  expect(rawLengths(sheet('$gutter: 12px;\\n$map: (\\n  sm: 480px,\\n  md: 768px,\\n);\\n'))).toEqual(
    [],
  );
  expect(rawLengths(sheet('@mixin ring($width: 2px) { outline-width: $width; }'))).toEqual([]);
});

unitTest('a named ARGUMENT is a use, however much it looks like a definition', () => {
  expect(rawLengths(sheet('.a { @include ring($width: 4px); }'))).toHaveLength(1);
});

unitTest('a comment, a quoted name and a class name are not lengths', () => {
  expect(rawLengths(sheet('// padding: 12px;\\n/* gap: 12px */\\n.a { padding: 0; }'))).toEqual([]);
  expect(rawLengths(sheet(".a { background: url('hero-640px.png'); }"))).toEqual([]);
  expect(rawLengths(sheet('.gap-12px { padding: 0; }'))).toEqual([]);
});

unitTest('a comment above a declaration is not part of the statement the finding quotes', () => {
  const findings = rawLengths(sheet('.a {\\n  // why this is wide\\n  padding: 12px;\\n}\\n'));
  expect(findings[0]?.cause).toContain('writes \`padding: 12px\`');
  expect(findings[0]?.fix).toStartWith('padding: tokens.space(3) — ');
  expect(findings[0]?.at).toBe('apps/web/site/page.module.scss:3');
});

unitTest('a viewport query and a shadow belong to their own guards', () => {
  expect(rawLengths(sheet('@media (min-width: 768px) { .a { padding: 0; } }'))).toEqual([]);
  expect(rawLengths(sheet('.a { box-shadow: 0 4px 12px black; }'))).toEqual([]);
});

unitTest('a value after an interpolation is still read as part of its declaration', () => {
  const findings = rawLengths(sheet('.a { margin: calc(-1 * #{tokens.space(4)}) 12px; }'));
  expect(findings[0]?.fix).toStartWith('margin: calc(-1 * #{tokens.space(4)}) tokens.space(3) — ');
});

unitTest('a local rem() or fluid() shadows the framework one, and is refused', () => {
  const findings = rawLengths(sheet('@function rem($value) {\\n  @return $value;\\n}\\n'));
  expect(findings).toHaveLength(1);
  expect(findings[0]?.cause).toContain('defines its own rem()');
  expect(findings[0]?.fix).toStartWith(
    'delete @function rem from apps/web/site/page.module.scss:1',
  );
});

const markup = (tsx: string) => [{ path: 'apps/web/site/page.tsx', tsx }];

unitTest('a px in an inline style is the same mistake in markup', () => {
  const findings = rawInlineLengths(markup("<div style={{ padding: '12px', width: '90px' }} />"));
  expect(findings.map((finding) => finding.fix.split(' in place of ')[0])).toEqual([
    'var(--space-3)',
    '5.625rem',
  ]);
  expect(rawInlineLengths(markup('<div style="margin-top: 20px" />'))).toHaveLength(1);
});

unitTest('a custom property and a hairline in an inline style are silent', () => {
  expect(
    rawInlineLengths(markup("<div style={{ '--fill': '40%', border: '1px solid' }} />")),
  ).toEqual([]);
});
`;

/** `guards/raw-length.ts` and its test. No index, no registry — the directory is the registration. */
export const rawLengthGuardFiles = (): readonly GeneratedFile[] => [
  { path: `guards/${NAME}.ts`, contents: source() },
  { path: `guards/${NAME}.test.ts`, contents: test() },
];
