// undeclared-custom-property: a `var(--x)` this app reads is a property something in it declares.
// `x verify` discovers every file in `guards/` and runs its `guard` inside the `boundaries`
// step — nothing registers this file, so nothing can forget to. Delete it to drop the rule.
//
// Read from the COMPILED sheets, so `tokens.space(7)` — a step the scale does not have — is the
// `var(--space-7)` it compiles to. Declared means: set by any stylesheet in the app (the global
// one emits every token), or named in a `.ts`/`.tsx` file, where an inline `style` sets it. A
// `var(--x, fallback)` declares its own answer and is never reported. While ANY sheet fails to
// compile the rule is silent: that sheet's declarations are unknown, and the build names it.

import type { Finding, Guard } from '@ultimat3/cli';

/** The app owns the codes its own conventions raise — this one is named for the guard. */
const CODE = 'X_UNDECLARED_CUSTOM_PROPERTY';

export interface CompiledSheet {
  /** App-root-relative POSIX path, so the finding names the file an author opens. */
  readonly path: string;
  /** The source, to find the line a compiled `var()` came from. */
  readonly scss: string;
  readonly css: string;
}

const DECLARED = /(--[A-Za-z_][\w-]*)\s*:/g;
const NAMED = /--[A-Za-z_][\w-]*/g;
/** `var(--x)` with no fallback: the `)` straight after the name is what makes it a bare read. */
const READ = /var\(\s*(--[A-Za-z_][\w-]*)\s*\)/g;

const lineOf = (text: string, index: number): number => text.slice(0, index).split('\n').length;

/**
 * The source line a compiled read came from. Written literally it is found as written; read
 * through a token function it is found as that call — `--space-7` is `space(7)`, `--color-bg` is
 * `role('bg')`. Line 1 when neither is there: a mixin three files away emitted it.
 */
const lineFor = (scss: string, name: string): number => {
  const literal = scss.indexOf(name);
  if (literal !== -1) return lineOf(scss, literal);
  const parts = name.slice(2).split('-');
  for (let split = 1; split < parts.length; split += 1) {
    const fn = parts.slice(0, split).join('-');
    const arg = parts.slice(split).join('-');
    const call = new RegExp(`(?:${fn}|role)\\(\\s*['"]?${arg}['"]?\\s*[,)]`).exec(scss);
    if (call !== null) return lineOf(scss, call.index);
  }
  return 1;
};

/** The steps a scale that IS declared offers, for a read one step off it: `--space-7` → `1 2 4`. */
const siblings = (
  name: string,
  declared: ReadonlySet<string>,
): { readonly stem: string; readonly offered: readonly string[] } => {
  const parts = name.slice(2).split('-');
  for (let split = parts.length - 1; split >= 1; split -= 1) {
    const stem = `--${parts.slice(0, split).join('-')}-`;
    const found = [...declared].filter((candidate) => candidate.startsWith(stem));
    if (found.length > 0) {
      return { stem, offered: found.map((candidate) => candidate.slice(stem.length)) };
    }
  }
  return { stem: '', offered: [] };
};

/**
 * Pure — the caller reads and compiles — so the rule is testable without a filesystem or Sass.
 * `sources` is the text of every `.ts`/`.tsx` file: a property named there is one an inline
 * `style` can set.
 */
export function undeclaredCustomProperties(
  sheets: readonly CompiledSheet[],
  sources: readonly string[],
): readonly Finding[] {
  const declared = new Set<string>();
  for (const sheet of sheets) {
    for (const match of sheet.css.matchAll(DECLARED)) declared.add(match[1] ?? '');
  }
  for (const source of sources) {
    for (const match of source.matchAll(NAMED)) declared.add(match[0]);
  }

  const findings: Finding[] = [];
  for (const sheet of sheets) {
    const reported = new Set<string>();
    for (const match of sheet.css.matchAll(READ)) {
      const name = match[1] ?? '';
      if (declared.has(name) || reported.has(name)) continue;
      reported.add(name);
      const line = lineFor(sheet.scss, name);
      const { stem, offered } = siblings(name, declared);
      findings.push({
        code: CODE,
        cause: `${sheet.path}:${line} reads var(${name}), and nothing in this app declares ${name} — the declaration it sits in computes to nothing, silently`,
        fix:
          offered.length > 0
            ? `${offered.join(' | ')} — the steps ${stem}* has; write one in place of \`${name.slice(stem.length)}\` at ${sheet.path}:${line}, then: x verify`
            : `declare ${name} where it is set — on the element, in the app's global.scss, or for a colour, radius or font through defineTheme() — or correct the name at ${sheet.path}:${line}, then: x verify`,
        at: `${sheet.path}:${line}`,
      });
    }
  }
  return findings;
}

export const guard: Guard = {
  summary: 'a custom property a stylesheet reads is one the app declares',
  async check(_root, sources) {
    const sheets: CompiledSheet[] = [];
    for (const file of await sources.files('{apps,packages}/**/*.scss')) {
      // A partial is `@use`d into the sheets that are compiled here; alone it is not a stylesheet.
      if ((file.path.split('/').pop() ?? '').startsWith('_')) continue;
      const compiled = await sources.compiled(file.path);
      // One sheet that does not compile and the declared set is incomplete: its declarations are
      // unknown, so every read of one would be reported as undeclared. That sheet is the build's
      // finding (X_PRERENDER_FAILED, with the Sass error); this rule waits for it to be repaired.
      if (compiled === undefined) return [];
      sheets.push({ path: file.path, scss: file.text, css: compiled.css });
    }
    const code = await sources.files('{apps,packages}/**/*.{ts,tsx}');
    return undeclaredCustomProperties(
      sheets,
      code.map((file) => file.text),
    );
  },
};
