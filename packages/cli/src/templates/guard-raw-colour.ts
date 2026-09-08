// The `raw-colour` guard `x new` ships: no stylesheet in this app names a colour.
// `AGENTS.md` has always stated the rule and NOTHING enforced it — `verify-checks.ts` said it rode
// on `packages/ui/src/tokens/tokens.test.ts`, which covers the framework's stylesheets and never
// the app's, so `color: #ff0000` in a scaffolded `page.module.scss` was green on `x verify`.

import { guardCode } from './guard';
import type { GeneratedFile } from './naming';

/**
 * Derived from the guard's name, never written as a literal — the same rule `x g guard` follows.
 * An `X_*` literal in framework source is a FRAMEWORK code: `error-catalog.test.ts` refuses one the
 * registry does not hold, and `wiki/Error-Codes.md` would owe it a row. The APP owns the codes its
 * own conventions raise, so this one is spelled by the file it lands in and nowhere else.
 */
const NAME = 'raw-colour';
const CODE = guardCode(NAME);

const source =
  (): string => `// raw-colour: every colour in this app is a semantic token, so dark theme is not a later project.
// \`x verify\` discovers every file in \`guards/\` and runs its \`guard\` inside the \`boundaries\`
// step — nothing registers this file, so nothing can forget to. Delete it to drop the rule.

import type { Finding, Guard } from '@ultimat3/cli';

/** The app owns the codes its own conventions raise — this one is named for the guard. */
const CODE = '${CODE}';

/** A hex literal. \`#{$x}\` is Sass interpolation, not a colour, and \`{\` is not a hex digit. */
const HEX = /#[0-9a-fA-F]{3,8}\\b/;
/**
 * A channel function OPENS a colour; it does not make one raw. \`rgb(var(--color-bg) / 1)\` is what
 * a semantic token compiles to, so the argument list decides — see \`literalChannelCall\`.
 * \`color-mix(\` is not one of these: \`color\` is followed by \`-\`, never \`(\`.
 */
const CHANNEL_FUNCTION = /\\b(rgba?|hsla?|lab|lch|oklab|oklch|color)\\(/gi;
/** The named colours a human actually types. The full CSS list would report \`.item\` selectors. */
const NAMED =
  /\\b(?:white|black|red|green|blue|yellow|orange|purple|pink|brown|gray|grey|silver|navy|teal|olive|lime|aqua|maroon|fuchsia|gold|beige|coral|crimson|indigo|violet|khaki|salmon|tan|turquoise|wheat)\\b/i;

/**
 * A DECLARATION, never a whole line: a selector carries no colon, so \`#hero { … }\` is not a value
 * and is never reported. The value stops at the first \`;\`, \`{\` or \`}\` — except a Sass \`#{…}\`
 * interpolation, which is a VALUE carrying braces. Without that alternative,
 * \`color: rgb(var(--color-fg) / #{\\$alpha});\` — what \`@ultimat3/ui\`'s own \`role()\` emits — reads as
 * the truncated \`rgb(var(--color-fg) / #\`, so the rule skips it instead of deciding it.
 */
const DECLARATION = /([\\w-]+)\\s*:\\s*((?:#\\{[^}]*\\}|[^;{}])+)/g;

export interface StyleFile {
  /** App-root-relative POSIX path, so the finding names the file an author opens. */
  readonly path: string;
  readonly scss: string;
}

/**
 * Comments blanked rather than removed, so the reported line number still points at the source
 * line. \`//\` is skipped when a \`:\` precedes it — \`url(https://…)\` is a value, not a comment.
 */
const blankComments = (scss: string): string =>
  scss
    .replaceAll(/\\/\\*[\\s\\S]*?\\*\\//g, (match) => match.replaceAll(/[^\\n]/g, ' '))
    .replaceAll(/(?<![:\\w])\\/\\/[^\\n]*/g, (match) => ' '.repeat(match.length));

/** Quoted text is a filename or a token name, never a colour: \`url('red.png')\`, \`role('bg')\`. */
const unquote = (value: string): string => value.replaceAll(/'[^']*'|"[^"]*"/g, ' ');

const lineOf = (text: string, index: number): number => text.slice(0, index).split('\\n').length;

/**
 * The BALANCED argument list of the call whose \`(\` sits at \`open\`. \`var(--x)\` nests, so reading
 * to the first \`)\` cuts \`rgb(var(--color-bg) / 1)\` in half and every rule below reads the wrong
 * text. \`undefined\` when the call is never closed — a value the declaration scan truncated.
 */
const argumentsAt = (value: string, open: number): string | undefined => {
  let depth = 0;
  for (let index = open; index < value.length; index += 1) {
    const character = value.charAt(index);
    if (character === '(') depth += 1;
    else if (character === ')') {
      depth -= 1;
      if (depth === 0) return value.slice(open + 1, index);
    }
  }
  return undefined;
};

/**
 * Every \`var(…)\` reference and every Sass \`#{…}\` interpolation removed — a slot a theme restates,
 * which is the whole point of a token. What is LEFT is what the author wrote by hand.
 */
const maskReferences = (args: string): string => {
  let out = '';
  let index = 0;
  while (index < args.length) {
    if (args.startsWith('#{', index)) {
      const end = args.indexOf('}', index);
      if (end === -1) break;
      index = end + 1;
      continue;
    }
    if (args.startsWith('var(', index)) {
      const group = argumentsAt(args, index + 3);
      if (group === undefined) break;
      index += group.length + 5;
      continue;
    }
    out += args.charAt(index);
    index += 1;
  }
  return out + args.slice(index);
};

/**
 * What may remain once the references are gone: separators, and — introduced by \`/\` or \`,\` and
 * LAST — one numeric alpha, because \`rgb(var(--color-fg) / 0.5)\` and the legacy
 * \`rgba(var(--color-fg), 0.5)\` are both the token form. The number may not be removed in general:
 * \`rgb(var(--x) 2 3)\` is two hand-written channels wearing one reference, and stays reported.
 * The optional leading identifier is \`color()\`'s colourspace — \`color(display-p3 var(--r) …)\`.
 */
const RESTATABLE = /^[\\s,/]*(?:[a-z][a-z0-9-]*\\s+)?[\\s,/]*(?:[/,]\\s*\\.?\\d+(?:\\.\\d+)?%?)?\\s*$/i;

/** The first channel function written with a literal channel, rendered whole for the finding. */
const literalChannelCall = (value: string): string | undefined => {
  for (const match of value.matchAll(CHANNEL_FUNCTION)) {
    const args = argumentsAt(value, match.index + match[0].length - 1);
    if (args === undefined) continue;
    if (RESTATABLE.test(maskReferences(args))) continue;
    return \`\${match[1] ?? ''}(\${args})\`;
  }
  return undefined;
};

/** Pure — the caller does the I/O — so the rule is testable without a filesystem. */
export function rawColours(files: readonly StyleFile[]): readonly Finding[] {
  const findings: Finding[] = [];
  for (const file of files) {
    const scss = blankComments(file.scss);
    for (const match of scss.matchAll(DECLARATION)) {
      const property = match[1] ?? '';
      const value = unquote(match[2] ?? '');
      const literal = HEX.exec(value)?.[0] ?? literalChannelCall(value) ?? NAMED.exec(value)?.[0];
      if (literal === undefined) continue;
      findings.push({
        code: CODE,
        cause: \`\${file.path}:\${lineOf(scss, match.index)} sets \${property} to the raw colour \${literal} — a value no theme can restate, so dark theme renders it unchanged\`,
        fix: \`replace \${literal} in \${file.path} with tokens.role('fg'), tokens.role('bg') or the role this element means, then: x verify\`,
        at: file.path,
      });
    }
  }
  return findings;
}

export const guard: Guard = {
  summary: 'a stylesheet names a semantic token, never a colour',
  async check(root) {
    const files: StyleFile[] = [];
    for await (const entry of new Bun.Glob('{apps,packages}/**/*.scss').scan({
      cwd: root,
      absolute: false,
    })) {
      const path = entry.split('\\\\').join('/');
      if (path.includes('node_modules/')) continue;
      files.push({ path, scss: await Bun.file(\`\${root}/\${path}\`).text() });
    }
    return rawColours(files);
  },
};
`;

const test =
  (): string => `// The rule, driven directly. Failure case first: a guard whose rule silently stopped matching is
// a green gate over the convention it was written to enforce.

import { expect, unitTest } from '@ultimat3/testing';
import { rawColours } from './raw-colour';

const sheet = (scss: string) => [{ path: 'apps/web/site/page.module.scss', scss }];

unitTest('a hex literal in a declaration is refused', () => {
  const findings = rawColours(sheet('.hero {\\n  color: #ff0000;\\n}\\n'));
  expect(findings).toHaveLength(1);
  expect(findings[0]?.code).toBe('${CODE}');
  expect(findings[0]?.cause).toContain('#ff0000');
  expect(findings[0]?.cause).toContain(':2');
});

unitTest('rgb(), hsl() and a named colour are the same rule', () => {
  const channels = rawColours(sheet('.a { background: rgb(1 2 3); }'));
  expect(channels).toHaveLength(1);
  // The whole call, never the bare \`rgb(\` — a fix line telling an author to replace \`rgb(\` names
  // nothing they can find in the file.
  expect(channels[0]?.cause).toContain('rgb(1 2 3)');
  expect(rawColours(sheet('.a { background: hsl(1 2% 3%); }'))).toHaveLength(1);
  expect(rawColours(sheet('.a { border-color: white; }'))).toHaveLength(1);
});

// The legitimate lookalike, and the one this rule got wrong: a channel function OVER TOKENS is the
// token form. \`tokens.role('bg')\` compiles to \`rgb(var(--color-bg) / 1)\`, so reading \`rgb(\` as a
// raw colour reports the idiom the rule exists to require — and a rule that noisy gets deleted.
unitTest('a channel function over var(--…) references is the token form', () => {
  expect(rawColours(sheet('.a { color: rgb(var(--color-fg) / 1); }'))).toEqual([]);
  expect(rawColours(sheet('.a { background-color: rgb(var(--color-bg-soft)); }'))).toEqual([]);
  expect(rawColours(sheet('.a { border: 1px solid rgb(var(--color-line)); }'))).toEqual([]);
  expect(rawColours(sheet('.a { outline-color: rgba(var(--color-accent), 0.5); }'))).toEqual([]);
  expect(rawColours(sheet('.a { color: color(display-p3 var(--r) var(--g) var(--b)); }'))).toEqual(
    [],
  );
});

// The other direction: one reference does not launder the literals beside it, or every raw colour
// gains a one-token disguise.
unitTest('a literal channel beside a reference is still refused', () => {
  expect(rawColours(sheet('.a { color: rgb(var(--color-fg-r) 2 3); }'))).toHaveLength(1);
  expect(rawColours(sheet('.a { color: rgb(var(--color-fg-x, #ff0000)); }'))).toHaveLength(1);
});

// A Sass \`#{…}\` interpolation is a value that carries braces, and the declaration scan has to read
// PAST it: \`role($name, $alpha)\` emits exactly this, so a value stopping at the \`{\` leaves the
// commonest token form of all undecided rather than accepted.
unitTest('an interpolated alpha is still the token form, and is read whole', () => {
  expect(rawColours(sheet('.a { color: rgb(var(--color-fg) / #{$alpha}); }'))).toEqual([]);
  expect(rawColours(sheet('.a { color: rgb(1 2 3 / #{$alpha}); }'))).toHaveLength(1);
});

unitTest('a token, a selector and a quoted filename are not colours', () => {
  expect(rawColours(sheet(".a { background: tokens.role('bg'); }"))).toEqual([]);
  expect(rawColours(sheet('#hero { padding: 0; }'))).toEqual([]);
  expect(rawColours(sheet(".a { background: url('red-hero.png'); }"))).toEqual([]);
});

unitTest('a commented-out colour is a note, not a declaration', () => {
  expect(rawColours(sheet('// color: #ff0000;\\n.a { padding: 0; }'))).toEqual([]);
  expect(rawColours(sheet('/* color: #ff0000; */\\n.a { padding: 0; }'))).toEqual([]);
});
`;

/** `guards/raw-colour.ts` and its test. No index, no registry — the directory is the registration. */
export const rawColourGuardFiles = (): readonly GeneratedFile[] => [
  { path: 'guards/raw-colour.ts', contents: source() },
  { path: 'guards/raw-colour.test.ts', contents: test() },
];
