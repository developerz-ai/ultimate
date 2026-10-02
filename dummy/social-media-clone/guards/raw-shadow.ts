// raw-shadow: elevation comes off the shadow scale, so dark theme deepens it instead of losing it.
// `x verify` discovers every file in `guards/` and runs its `guard` inside the `boundaries`
// step — nothing registers this file, so nothing can forget to. Delete it to drop the rule.
//
// A shadow is RAW when a length in it was written by hand. `tokens.shadow('md')`, `none`, a
// hairline ring (`inset 0 0 0 1px …`) and a line drawn from tokens (`inset 0 #{tokens.stroke(thick)} …`)
// carry no such length and are never reported.

import type { Finding, Guard } from '@ultimat3/cli';

/** The app owns the codes its own conventions raise — this one is named for the guard. */
const CODE = 'X_RAW_SHADOW';

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
const SHADOW_PROPERTY = /^(?:box-shadow|text-shadow)$/;

/** The index just past the `)` that closes the `(` at `open`, or `undefined` when none does. */
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

/**
 * A token read — `var(--shadow-md)`, a module call (`tokens.space(2)`, `t.rem(-4px)`) or the bare
 * `shadow(md)` — with its whole argument list, so the px handed to `rem()` is not read as raw.
 */
const TOKEN_CALL = /(?<![\w-])(?:var|(?:[\w-]+\.)[\w-]+|shadow|rem|space|stroke)\(/g;

const withoutTokens = (value: string): string => {
  let out = value;
  for (const match of value.matchAll(TOKEN_CALL)) {
    const open = match.index + match[0].length - 1;
    const close = closeOf(out, open);
    if (close !== undefined) {
      out = out.slice(0, match.index) + blank(out.slice(match.index, close)) + out.slice(close);
    }
  }
  return out;
};

/** A hand-written length: any unit, any sign — except `0` and the `1px` of a hairline ring. */
const LENGTH = /(?<![\w.#-])-?(\d*\.?\d+)(px|rem|em|vh|vw|%)/g;

const rawLength = (value: string): string | undefined => {
  for (const match of withoutTokens(value).matchAll(LENGTH)) {
    const amount = Number(match[1]);
    if (amount === 0 || (amount === 1 && match[2] === 'px')) continue;
    return match[0];
  }
  return undefined;
};

/** Pure — the caller does the I/O — so the rule is testable without a filesystem. */
export function rawShadows(files: readonly StyleFile[]): readonly Finding[] {
  const findings: Finding[] = [];
  for (const file of files) {
    const scss = blankComments(file.scss);
    const ns = namespaceOf(file.scss);
    for (const match of scss.matchAll(DECLARATION)) {
      const property = match[1] ?? '';
      const value = (match[2] ?? '').trim().replaceAll(/\s+/g, ' ');
      const dropShadow = /drop-shadow\(/.test(value);
      if (!SHADOW_PROPERTY.test(property) && !dropShadow) continue;
      const literal = rawLength(value);
      if (literal === undefined) continue;
      const line = lineOf(scss, match.index);
      // An inset shadow is a LINE drawn inside the box, not elevation: its repair is the stroke
      // scale, and telling its author to reach for `shadow()` would be telling them to delete it.
      const written = /\binset\b/.test(value)
        ? `write each length of this inset line as ${ns}.stroke(thick), ${ns}.space(<step>) or ${ns}.rem(<px>)`
        : `${property}: ${ns}.shadow('sm') — or 'xs' 'md' 'lg' 'xl'; a card or popover takes @include ${ns}.surface`;
      findings.push({
        code: CODE,
        cause: `${file.path}:${line} writes \`${property}: ${value}\` — a shadow with the hand-written length ${literal}, which no theme restates: dark mode keeps the light theme's elevation`,
        fix: `${written} — at ${file.path}:${line}, then: x verify`,
        at: `${file.path}:${line}`,
      });
    }
  }
  return findings;
}

export const guard: Guard = {
  summary: 'a shadow comes off the shadow scale, never a hand-written offset and blur',
  async check(_root, sources) {
    const sheets = await sources.files('{apps,packages}/**/*.scss');
    return rawShadows(sheets.map((file) => ({ path: file.path, scss: file.text })));
  },
};
