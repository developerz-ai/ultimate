// The `undefined-style-class` guard `x new` ships: `styles.<name>` is a class its `.module.scss`
// COMPILES. `cx` drops an `undefined`, so a dead class renders nothing wrong and says nothing —
// the deployed demo carried one (`styles.wordmark`) through every gate until this guard read it.
// The class list is the build's own (`GuardSources.compiled`), so a mixin-generated class counts.

import { guardCode } from './guard';
import type { GeneratedFile } from './naming';

/** Derived from the guard's name, never a literal: an `X_*` literal here is a FRAMEWORK code. */
const NAME = 'undefined-style-class';
const CODE = guardCode(NAME);

const source =
  (): string => `// undefined-style-class: a class a component asks its stylesheet for is a class the sheet compiles.
// \`x verify\` discovers every file in \`guards/\` and runs its \`guard\` inside the \`boundaries\`
// step — nothing registers this file, so nothing can forget to. Delete it to drop the rule.
//
// Read from the COMPILED sheet, so a class a mixin generates or \`&-suffix\` nests is one, and a
// class inside \`:global()\` is not. A computed member (\`styles[name]\`) is out of scope: its key is
// only known when the component runs. A sheet that does not compile is the build's refusal.

import type { Finding, Guard } from '@ultimat3/cli';

/** The app owns the codes its own conventions raise — this one is named for the guard. */
const CODE = '${CODE}';

export interface MarkupFile {
  /** App-root-relative POSIX path, so the finding names the file an author opens. */
  readonly path: string;
  readonly tsx: string;
}

/** The classes a stylesheet compiles, by app-root-relative path; \`undefined\` when it does not. */
export type CompiledClasses = (sheet: string) => Promise<readonly string[] | undefined>;

const blank = (text: string): string => text.replaceAll(/[^\\n]/g, ' ');

/** Comments blanked rather than removed, so a reported line number still points at the source. */
const blankComments = (tsx: string): string =>
  tsx.replaceAll(/\\/\\*[\\s\\S]*?\\*\\//g, blank).replaceAll(/(?<![:\\w'"\`])\\/\\/[^\\n]*/g, blank);

const lineOf = (text: string, index: number): number => text.slice(0, index).split('\\n').length;

/** \`import styles from './page.module.scss'\` — the binding, and the sheet it reads. */
const SHEET_IMPORT =
  /import\\s+([A-Za-z_$][\\w$]*)\\s+from\\s+['"](\\.{1,2}\\/[^'"]+\\.module\\.s?css)['"]/g;

/** \`a/b/page.tsx\` + \`../x.module.scss\` → \`a/x.module.scss\`. */
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

/** Pure but for \`classesOf\`, which the caller supplies — so the rule is testable without Sass. */
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
      // \`styles.hero\` and \`styles['hero-title']\` — a static key either way. \`styles[name]\` has no
      // quote after the bracket and is not matched. A path is not a read: \`'./shell.module.scss'\`
      // holds \`shell.module\`, so a name that follows a slash, a quote or a dash is skipped.
      const read = new RegExp(
        \`(?<![\\\\w$./'"-])\${binding.replaceAll('$', '\\\\$')}(?:\\\\.([A-Za-z_$][\\\\w$]*)|\\\\[\\\\s*(['"])([^'"]+)\\\\2\\\\s*\\\\])\`,
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
          cause: \`\${file.path}:\${line} reads \${binding}.\${name}, and \${sheet} compiles no class \\\`\${name}\\\` — the element renders with no class, and nothing says so\`,
          fix:
            meant === undefined
              ? \`add \\\`.\${name} { … }\\\` to \${sheet}, or delete the read at \${file.path}:\${line}, then: x verify\`
              : \`\${binding}\${/^[A-Za-z_$][\\w$]*$/.test(meant) ? \`.\${meant}\` : \`['\${meant}']\`} — at \${file.path}:\${line}; \${sheet} declares \\\`.\${meant}\\\`, then: x verify\`,
          at: \`\${file.path}:\${line}\`,
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
`;

const test =
  (): string => `// The rule, driven directly. Failure case first: a guard whose rule silently stopped matching is
// a green gate over the convention it was written to enforce.

import { expect, unitTest } from '@ultimat3/testing';
import { undefinedStyleClasses } from './undefined-style-class';

const SHEETS: Readonly<Record<string, readonly string[]>> = {
  'apps/web/site/page.module.scss': ['hero', 'hero-title', 'tone-accent'],
  'apps/web/shared/shell.module.scss': ['shell'],
};
const classesOf = async (sheet: string) => SHEETS[sheet];

const page = (body: string, imports = "import styles from './page.module.scss';") => [
  { path: 'apps/web/site/page.tsx', tsx: \`\${imports}\\n\${body}\\n\` },
];
const check = (body: string, imports?: string) =>
  undefinedStyleClasses(page(body, imports), classesOf);

unitTest('a class the sheet does not compile is refused, with the line it is read on', async () => {
  const findings = await check('export const Page = () => <h1 class={styles.missing} />;');
  expect(findings).toHaveLength(1);
  expect(findings[0]?.code).toBe('${CODE}');
  expect(findings[0]?.at).toBe('apps/web/site/page.tsx:2');
  expect(findings[0]?.cause).toContain(
    'apps/web/site/page.module.scss compiles no class \`missing\`',
  );
  expect(findings[0]?.fix).toStartWith('add \`.missing { … }\` to apps/web/site/page.module.scss');
});

unitTest('a near miss is repaired with the class the sheet does declare', async () => {
  const dot = await check('export const Page = () => <h1 class={styles.heroo} />;');
  expect(dot[0]?.fix).toStartWith('styles.hero — at ');
  const bracket = await check("export const Page = () => <h1 class={styles['heroTitle']} />;");
  expect(bracket[0]?.fix).toStartWith("styles['hero-title'] — at ");
});

unitTest('a bracket read, a classList key and a second binding are all reads', async () => {
  expect(await check("export const Page = () => <h1 class={styles['nope']} />;")).toHaveLength(1);
  expect(
    await check('export const Page = () => <h1 classList={{ [styles.nope]: on() }} />;'),
  ).toHaveLength(1);
  const two =
    "import styles from './page.module.scss';\\nimport shell from '../shared/shell.module.scss';";
  const findings = await check('export const Page = () => <h1 class={shell.hero} />;', two);
  expect(findings).toHaveLength(1);
  expect(findings[0]?.cause).toContain('apps/web/shared/shell.module.scss');
});

unitTest('one missing class read five times is one finding', async () => {
  const body = 'const a = [styles.gone, styles.gone, styles.gone, styles.gone, styles.gone];';
  expect(await check(body)).toHaveLength(1);
});

// The legitimate lookalikes — the reason the rule can stay switched on.
unitTest('a compiled class, however it is read, is silent', async () => {
  const silent = [
    'export const Page = () => <h1 class={styles.hero} />;',
    "export const Page = () => <h1 class={styles['hero-title']} />;",
    'export const Page = () => <h1 classList={{ [styles.hero]: on() }} />;',
    // Generated by a mixin: only the compiled sheet knows it exists.
    "export const Page = () => <h1 class={styles['tone-accent']} />;",
  ];
  for (const body of silent) expect(await check(body)).toEqual([]);
});

unitTest('a computed key, a comment and another object are out of scope', async () => {
  const silent = [
    'export const Page = (p) => <h1 class={styles[p.tone]} />;',
    \`export const Page = (p) => <h1 class={styles[\\\`tone-\\\${p.tone}\\\`]} />;\`,
    '// styles.missing\\nexport const Page = () => <h1 class={styles.hero} />;',
    'export const Page = (p) => <h1 class={p.styles.missing} />;',
    'export const Page = () => <h1 class={mystyles.missing} />;',
  ];
  for (const body of silent) expect(await check(body)).toEqual([]);
});

unitTest("a sheet that does not compile is the build's finding, not this guard's", async () => {
  const imports = "import styles from './broken.module.scss';";
  expect(await check('export const Page = () => <h1 class={styles.any} />;', imports)).toEqual([]);
});
`;

/** `guards/undefined-style-class.ts` and its test. No index, no registry — the directory is the registration. */
export const undefinedStyleClassGuardFiles = (): readonly GeneratedFile[] => [
  { path: `guards/${NAME}.ts`, contents: source() },
  { path: `guards/${NAME}.test.ts`, contents: test() },
];
