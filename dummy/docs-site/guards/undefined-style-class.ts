// undefined-style-class: a class a component asks its stylesheet for is a class the sheet compiles.
// `x verify` discovers every file in `guards/` and runs its `guard` inside the `boundaries`
// step — nothing registers this file, so nothing can forget to. Delete it to drop the rule.
//
// Read from the COMPILED sheet, so a class a mixin generates or `&-suffix` nests is one, and a
// class inside `:global()` is not. A computed member (`styles[name]`) is out of scope: its key is
// only known when the component runs. A sheet that does not compile is the build's refusal.

import type { Finding, Guard } from '@ultimat3/cli';

/** The app owns the codes its own conventions raise — this one is named for the guard. */
const CODE = 'X_UNDEFINED_STYLE_CLASS';

export interface MarkupFile {
  /** App-root-relative POSIX path, so the finding names the file an author opens. */
  readonly path: string;
  readonly tsx: string;
}

/** The classes a stylesheet compiles, by app-root-relative path; `undefined` when it does not. */
export type CompiledClasses = (sheet: string) => Promise<readonly string[] | undefined>;

const blank = (text: string): string => text.replaceAll(/[^\n]/g, ' ');

/** Comments blanked rather than removed, so a reported line number still points at the source. */
const blankComments = (tsx: string): string =>
  tsx.replaceAll(/\/\*[\s\S]*?\*\//g, blank).replaceAll(/(?<![:\w'"`])\/\/[^\n]*/g, blank);

const lineOf = (text: string, index: number): number => text.slice(0, index).split('\n').length;

/** `import styles from './page.module.scss'` — the binding, and the sheet it reads. */
const SHEET_IMPORT =
  /import\s+([A-Za-z_$][\w$]*)\s+from\s+['"](\.{1,2}\/[^'"]+\.module\.s?css)['"]/g;

/** `a/b/page.tsx` + `../x.module.scss` → `a/x.module.scss`. */
const resolve = (from: string, specifier: string): string => {
  const parts = from.split('/').slice(0, -1);
  for (const segment of specifier.split('/')) {
    if (segment === '..') parts.pop();
    else if (segment !== '.') parts.push(segment);
  }
  return parts.join('/');
};

/** The declared class a misspelt one most likely meant: one edit away, or the same letters. */
const nearest = (name: string, declared: readonly string[]): string | undefined => {
  const fold = (text: string): string => text.toLowerCase().replaceAll(/[-_]/g, '');
  return (
    declared.find((candidate) => fold(candidate) === fold(name)) ??
    declared.find(
      (candidate) =>
        Math.abs(candidate.length - name.length) <= 1 &&
        (candidate.startsWith(name.slice(0, -1)) || name.startsWith(candidate.slice(0, -1))),
    )
  );
};

/** Pure but for `classesOf`, which the caller supplies — so the rule is testable without Sass. */
export async function undefinedStyleClasses(
  files: readonly MarkupFile[],
  classesOf: CompiledClasses,
): Promise<readonly Finding[]> {
  const findings: Finding[] = [];
  for (const file of files) {
    const tsx = blankComments(file.tsx);
    for (const imported of tsx.matchAll(SHEET_IMPORT)) {
      const binding = imported[1] ?? '';
      const sheet = resolve(file.path, imported[2] ?? '');
      const declared = await classesOf(sheet);
      if (declared === undefined) continue;
      // `styles.hero` and `styles['hero-title']` — a static key either way. `styles[name]` has no
      // quote after the bracket and is not matched. A path is not a read: `'./shell.module.scss'`
      // holds `shell.module`, so a name that follows a slash, a quote or a dash is skipped.
      const read = new RegExp(
        `(?<![\\w$./'"-])${binding.replaceAll('$', '\\$')}(?:\\.([A-Za-z_$][\\w$]*)|\\[\\s*(['"])([^'"]+)\\2\\s*\\])`,
        'g',
      );
      const reported = new Set<string>();
      for (const use of tsx.matchAll(read)) {
        const name = use[1] ?? use[3] ?? '';
        if (declared.includes(name) || reported.has(name)) continue;
        reported.add(name);
        const line = lineOf(tsx, use.index);
        const meant = nearest(name, declared);
        findings.push({
          code: CODE,
          cause: `${file.path}:${line} reads ${binding}.${name}, and ${sheet} compiles no class \`${name}\` — the element renders with no class, and nothing says so`,
          fix:
            meant === undefined
              ? `add \`.${name} { … }\` to ${sheet}, or delete the read at ${file.path}:${line}, then: x verify`
              : `${binding}${/^[A-Za-z_$][\w$]*$/.test(meant) ? `.${meant}` : `['${meant}']`} — at ${file.path}:${line}; ${sheet} declares \`.${meant}\`, then: x verify`,
          at: `${file.path}:${line}`,
        });
      }
    }
  }
  return findings;
}

export const guard: Guard = {
  summary: 'a class a component reads off its stylesheet is a class that sheet compiles',
  async check(_root, sources) {
    const markup = await sources.files('{apps,packages}/**/*.tsx');
    return undefinedStyleClasses(
      markup.map((file) => ({ path: file.path, tsx: file.text })),
      async (sheet) => {
        const compiled = await sources.compiled(sheet);
        return compiled === undefined ? undefined : Object.keys(compiled.classes);
      },
    );
  },
};
