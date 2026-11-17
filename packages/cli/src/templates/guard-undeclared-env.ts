// The `undeclared-env` guard `x new` ships: an app reads an environment variable its env schema
// declares. `env.STRIPE_KEY` off `defineEnv` fails tsc when the key is undeclared, but the raw
// `process.env.STRIPE_KEY ?? ''` beside it passed typecheck, lint, boundaries and errors, and
// `x env check` never named it — so a deploy without it booted and failed at the first read.

import { FRAMEWORK_ENV } from '@ultimat3/core';
import { guardCode } from './guard';
import type { GeneratedFile } from './naming';

/** Derived from the guard's name, never a literal: an `X_*` literal here is a FRAMEWORK code. */
const NAME = 'undeclared-env';
const CODE = guardCode(NAME);

/**
 * The names the framework reads itself (`@ultimat3/core`'s `FRAMEWORK_ENV`), written INTO the rule
 * rather than imported by it: a guard is a dependency-free text rule, and the list moves with the
 * framework the guard ships in. Space-joined rows of at most ~90 columns, so the list stays a
 * screenful rather than a name per line.
 */
const frameworkRows = (): string => {
  const heads = FRAMEWORK_ENV.filter((entry) => entry.prefix === true).map((entry) => entry.name);
  // A name its head already admits (\`ULTIMATE_ENV\` under \`ULTIMATE_\`) is not written twice.
  const names = FRAMEWORK_ENV.filter(
    (entry) => entry.prefix !== true && !heads.some((head) => entry.name.startsWith(head)),
  ).map((entry) => entry.name);
  const rows: string[] = [];
  for (const name of [...new Set(names)].sort()) {
    const last = rows.length - 1;
    const row = rows[last];
    if (row !== undefined && row.length + name.length < 86) rows[last] = `${row} ${name}`;
    else rows.push(name);
  }
  return rows.map((row) => `    '${row}',`).join('\n');
};

/** The heads every `ULTIMATE_*`-style name under them shares, quoted for the rule. */
const frameworkPrefixes = (): string =>
  FRAMEWORK_ENV.filter((entry) => entry.prefix === true)
    .map((entry) => `'${entry.name}'`)
    .join(', ');

const source =
  (): string => `// undeclared-env: every environment variable this app reads is declared in app.config.ts.
// \`x verify\` discovers every file in \`guards/\` and runs its \`guard\` inside the \`boundaries\`
// step — nothing registers this file, so nothing can forget to.
//
// Read: \`process.env.X\`, \`Bun.env.X\`, \`import.meta.env.X\` and the \`['X']\` forms, in app source
// (\`apps/**\`, \`packages/**\`; never a test). Declared: a key of \`envSchema\` or of the object
// \`defineEnv({ … })\` is handed, in \`app.config.ts\` — the declaration \`x env check\` reads.
// Allowed: every name the framework reads itself, \`NODE_ENV\` among them.

import type { Finding, Guard } from '@ultimat3/cli';

/** The app owns the codes its own conventions raise — this one is named for the guard. */
const CODE = '${CODE}';

/** The framework's own names, exact, then the heads every name under them shares. */
const FRAMEWORK = new Set(
  [
${frameworkRows()}
  ]
    .join(' ')
    .split(' '),
);
const FRAMEWORK_PREFIXES = [${frameworkPrefixes()}];

/** A literal read: \`process.env.X\` / \`Bun.env['X']\`. A computed key names nothing to check. */
const READ =
  /\\b(?:process\\.env|Bun\\.env|import\\.meta\\.env)(?:\\.([A-Za-z_$][\\w$]*)|\\[\\s*(['"\`])([A-Za-z_$][\\w$]*)\\2\\s*\\])/g;
/** Where the declaration opens: the \`envSchema\` export, or an object handed to \`defineEnv(\`. */
const OPENS = /\\bexport\\s+const\\s+envSchema\\b[^=]*=\\s*\\{|\\bdefineEnv\\(\\s*\\{/g;
/** A key at the declaration's top level, once every nested group is emptied. */
const KEY = /(?:^|[{,\\s])['"]?([A-Za-z_$][\\w$]*)['"]?\\s*:/g;

export interface SourceFile {
  /** App-root-relative POSIX path, so the finding names the file an author opens. */
  readonly path: string;
  readonly source: string;
}

/** Comments blanked IN PLACE — not deleted — so a reported line number still points at the source. */
const blank = (text: string): string =>
  text
    .replaceAll(/\\/\\*[\\s\\S]*?\\*\\//g, (match) => match.replaceAll(/[^\\n]/g, ' '))
    .replaceAll(/(?<![:\\w])\\/\\/[^\\n]*/g, (match) => ' '.repeat(match.length));

const lineOf = (text: string, index: number): number => text.slice(0, index).split('\\n').length;

/** The body of the brace group opening at \`open\`, or what is left of the text if it never closes. */
const groupAt = (text: string, open: number): string => {
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    const character = text.charAt(index);
    if (character === '{') depth += 1;
    else if (character === '}' && --depth === 0) return text.slice(open + 1, index);
  }
  return text.slice(open + 1);
};

/** Every name \`app.config.ts\` declares: the top-level keys of each declaration it opens. */
export function declaredNames(config: string): ReadonlySet<string> {
  const names = new Set<string>();
  const text = blank(config);
  for (const open of text.matchAll(OPENS)) {
    let body = groupAt(text, open.index + open[0].length - 1);
    // Innermost first, until none is left: a declaration's own \`{ type: … }\` keys are not names.
    for (let before = ''; before !== body; ) {
      before = body;
      body = body.replaceAll(/\\{[^{}]*\\}|\\[[^[\\]]*\\]/g, ' ');
    }
    for (const key of body.matchAll(KEY)) names.add(key[1] ?? '');
  }
  return names;
}

const isFramework = (name: string): boolean =>
  FRAMEWORK.has(name) || FRAMEWORK_PREFIXES.some((head) => name.startsWith(head));

/** Pure — the caller does the I/O — so the rule is testable without a filesystem. */
export function undeclaredEnv(files: readonly SourceFile[], config: string): readonly Finding[] {
  const declared = declaredNames(config);
  const findings: Finding[] = [];
  for (const file of files) {
    const text = blank(file.source);
    for (const match of text.matchAll(READ)) {
      const name = match[1] ?? match[3] ?? '';
      if (declared.has(name) || isFramework(name)) continue;
      findings.push({
        code: CODE,
        cause: \`\${file.path}:\${lineOf(text, match.index)} reads \${match[0]}, which app.config.ts does not declare — x env check never asks for it, so a deploy without it boots and fails at the first read\`,
        fix: \`add \${name}: { type: 'string', description: '…' } to envSchema in app.config.ts, read it as env.\${name} in \${file.path}, then: x env example\`,
        at: file.path,
      });
    }
  }
  return findings;
}

export const guard: Guard = {
  summary: 'an environment variable is read only once app.config.ts declares it',
  async check(_root, sources) {
    const config = (await sources.files('app.config.ts'))[0]?.text ?? '';
    const files: SourceFile[] = [];
    for (const pattern of ['{apps,packages}/**/*.ts', '{apps,packages}/**/*.tsx']) {
      for (const file of await sources.files(pattern)) {
        if (/\\.test\\.tsx?$|\\.d\\.ts$|(?:^|\\/)e2e\\//.test(file.path)) continue;
        files.push({ path: file.path, source: file.text });
      }
    }
    return undeclaredEnv(files, config);
  },
};
`;

const test =
  (): string => `// The rule, driven directly. Failure case first: a guard whose rule silently stopped matching is
// a green gate over the convention it was written to enforce.

import { expect, unitTest } from '@ultimat3/testing';
import { declaredNames, undeclaredEnv } from './undeclared-env';

const CONFIG = "export const envSchema = {\\n  STRIPE_KEY: { type: 'string', values: ['A'] },\\n};\\n";
const file = (source: string) => [{ path: 'apps/web/app/billing/service.ts', source }];

unitTest('a read of an undeclared name is refused, and the fix is the declaration', () => {
  const findings = undeclaredEnv(file("export const key = process.env.SENTRY_KEY ?? '';"), CONFIG);
  expect(findings).toHaveLength(1);
  expect(findings[0]?.code).toBe('${CODE}');
  expect(findings[0]?.fix).toContain('SENTRY_KEY: {');
  expect(undeclaredEnv(file("Bun.env['SENTRY_KEY'];"), CONFIG)).toHaveLength(1);
});

unitTest('a declared name, a framework name and a computed key are not reported', () => {
  expect(undeclaredEnv(file('process.env.STRIPE_KEY;'), CONFIG)).toEqual([]);
  expect(undeclaredEnv(file('Bun.env.NODE_ENV; Bun.env.DATABASE_URL;'), CONFIG)).toEqual([]);
  expect(undeclaredEnv(file('Bun.env[name];'), CONFIG)).toEqual([]);
});

// A declaration's own keys (\\\`type\\\`, \\\`values\\\`) are not names it declares.
unitTest('only the top-level keys of the declaration are declared', () => {
  expect([...declaredNames(CONFIG)]).toEqual(['STRIPE_KEY']);
  expect([...declaredNames("export const env = defineEnv({ PORT: { type: 'port' } });")]).toEqual([
    'PORT',
  ]);
});
`;

/** `guards/undeclared-env.ts` and its test. The directory is the registration. */
export const undeclaredEnvGuardFiles = (): readonly GeneratedFile[] => [
  { path: 'guards/undeclared-env.ts', contents: source() },
  { path: 'guards/undeclared-env.test.ts', contents: test() },
];
