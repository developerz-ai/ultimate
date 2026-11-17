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
// (\`apps/**\`, \`packages/**\`; never a test). Declared: a key of the \`envSchema\` export of
// \`app.config.ts\` — the one declaration \`x env check\` reads. A \`defineEnv(\` handed anything
// else (an inline \`{ … }\`) is refused: its record is unreachable once \`defineEnv\` returns values.
// Elsewhere, a record handed to \`defineEnv(\` — inline or a same-file \`const\` — names only keys
// \`envSchema\` declares: one built from \`envSchema.X\` reads it twice, never a second declaration.
// Allowed: every name the framework reads itself, \`NODE_ENV\` among them, and the OS's own.

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
/** Where the declaration opens: the \`envSchema\` export, the one form every \`x\` command reads. */
const OPENS = /\\bexport\\s+const\\s+envSchema\\b[^=]*=\\s*\\{/g;
/** A \`defineEnv(\` handed anything but \`envSchema\`: a declaration no command can read back. */
const OTHER_FORM = /\\bdefineEnv\\(\\s*(?!envSchema\\s*[,)])/g;
/** A \`defineEnv(\` call in app source: its record inline (\`{\`) or a name to resolve in the file. */
const CALL = /\\bdefineEnv\\(\\s*(?:(\\{)|([A-Za-z_$][\\w$]*))/g;
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

/** The top-level keys of the record opening at \`open\`, every nested group emptied first. */
const topLevelKeys = (text: string, open: number): readonly string[] => {
  let body = groupAt(text, open);
  // Innermost first, until none is left: a declaration's own \`{ type: … }\` keys are not names.
  for (let before = ''; before !== body; ) {
    before = body;
    body = body.replaceAll(/\\{[^{}]*\\}|\\[[^[\\]]*\\]/g, ' ');
  }
  return [...body.matchAll(KEY)].map((key) => key[1] ?? '');
};

/** Every name \`app.config.ts\` declares: the top-level keys of each declaration it opens. */
export function declaredNames(config: string): ReadonlySet<string> {
  const names = new Set<string>();
  const text = blank(config);
  for (const open of text.matchAll(OPENS)) {
    for (const key of topLevelKeys(text, open.index + open[0].length - 1)) names.add(key);
  }
  return names;
}

/** The OS's own, set by the machine and never by a deploy: \`env: { PATH }\` for a child process. */
const AMBIENT = new Set(['HOME', 'HOSTNAME', 'LANG', 'PATH', 'PWD', 'SHELL', 'TMPDIR', 'USER']);

/**
 * Every string's CONTENTS blanked in place, so a name quoted in prose or data (a generated docs
 * file) is no read. A template's \`\${…}\` stays code. A regex literal holding a quote reads as a
 * string opening: the rest of that file then reports less, never something false.
 */
const codeOnly = (text: string): string => {
  const out = text.split('');
  const braces: number[] = [];
  let quote = '';
  for (let index = 0; index < out.length; index += 1) {
    const character = text.charAt(index);
    if (quote === '') {
      const top = braces.length - 1;
      if (character === "'" || character === '"' || character === '\`') quote = character;
      else if (character === '{' && top >= 0) braces[top] = (braces[top] ?? 0) + 1;
      else if (character === '}' && top >= 0) {
        if ((braces[top] ?? 0) === 0) {
          braces.pop();
          quote = '\`';
        } else braces[top] = (braces[top] ?? 0) - 1;
      }
      continue;
    }
    if (character === '\\\\') {
      out[index] = ' ';
      if (text.charAt(index + 1) !== '\\n') out[index + 1] = ' ';
      index += 1;
    } else if (character === quote) quote = '';
    else if (quote === '\`' && character === '$' && text.charAt(index + 1) === '{') {
      braces.push(0);
      quote = '';
      index += 1;
    } else if (character !== '\\n') out[index] = ' ';
  }
  return out.join('');
};

/** \`app.config.ts\` declaring its env any other way than the \`envSchema\` export. */
const formFindings = (config: string): readonly Finding[] => {
  const text = blank(config);
  const code = codeOnly(text);
  return [...text.matchAll(OTHER_FORM)]
    .filter((match) => code.charAt(match.index) !== ' ')
    .map((match) => ({
      code: CODE,
      cause: \`app.config.ts:\${lineOf(text, match.index)} hands defineEnv a record that is not the envSchema export — defineEnv returns values, so x env check, x env example, x secrets and x deploy read no declaration\`,
      fix: 'export const envSchema = { … } satisfies EnvSchema; export const env = defineEnv(envSchema);   // in app.config.ts: move the record defineEnv was handed into envSchema, then: x env example',
      at: 'app.config.ts',
    }));
};

const isFramework = (name: string): boolean =>
  FRAMEWORK.has(name) || FRAMEWORK_PREFIXES.some((head) => name.startsWith(head));

/** Where the record a \`defineEnv(\` call is handed opens: inline, or a same-file \`const\`. */
const recordOpen = (text: string, call: RegExpMatchArray): number | undefined => {
  if (call[1] !== undefined) return (call.index ?? 0) + call[0].length - 1;
  const named = new RegExp(\`\\\\bconst\\\\s+\${call[2] ?? ''}\\\\b[^=]*=\\\\s*\\\\{\`).exec(text);
  return named === null ? undefined : named.index + named[0].length - 1;
};

/** A \`defineEnv(\` record in app source naming a key \`envSchema\` does not: invisible to \`x env\`. */
const recordFindings = (file: SourceFile, declared: ReadonlySet<string>): readonly Finding[] => {
  const text = blank(file.source);
  const code = codeOnly(text);
  const findings: Finding[] = [];
  for (const call of text.matchAll(CALL)) {
    const open = code.charAt(call.index) === ' ' ? undefined : recordOpen(code, call);
    if (open === undefined) continue;
    for (const name of topLevelKeys(code, open)) {
      if (declared.has(name) || isFramework(name) || AMBIENT.has(name)) continue;
      findings.push({
        code: CODE,
        cause: \`\${file.path}:\${lineOf(text, call.index)} hands defineEnv a record declaring \${name}, which envSchema in app.config.ts does not — x env check, x env example, x secrets and x deploy never ask for it\`,
        fix: \`add \${name}: { type: 'string', description: '…' } to envSchema in app.config.ts, read it as envSchema.\${name} in \${file.path}, then: x env example\`,
        at: file.path,
      });
    }
  }
  return findings;
};

/** Pure — the caller does the I/O — so the rule is testable without a filesystem. */
export function undeclaredEnv(files: readonly SourceFile[], config: string): readonly Finding[] {
  const declared = declaredNames(config);
  const findings: Finding[] = [...formFindings(config)];
  for (const file of files) {
    findings.push(...recordFindings(file, declared));
    const text = blank(file.source);
    const code = codeOnly(text);
    for (const match of text.matchAll(READ)) {
      const name = match[1] ?? match[3] ?? '';
      if (code.charAt(match.index) === ' ') continue;
      if (declared.has(name) || isFramework(name) || AMBIENT.has(name)) continue;
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

// A declaration's own keys (\\\`type\\\`, \\\`values\\\`) are not names it declares, and an inline
// \\\`defineEnv({ … })\\\` declares nothing: it is refused, with the conversion as its fix.
unitTest('only the top-level keys of the envSchema export are declared', () => {
  expect([...declaredNames(CONFIG)]).toEqual(['STRIPE_KEY']);
  const inline = "export const env = defineEnv({ PORT: { type: 'port' } });";
  expect([...declaredNames(inline)]).toEqual([]);
  const [refused] = undeclaredEnv([], inline);
  expect(refused?.at).toBe('app.config.ts');
  expect(refused?.fix).toContain('defineEnv(envSchema)');
});
`;

/** `guards/undeclared-env.ts` and its test. The directory is the registration. */
export const undeclaredEnvGuardFiles = (): readonly GeneratedFile[] => [
  { path: 'guards/undeclared-env.ts', contents: source() },
  { path: 'guards/undeclared-env.test.ts', contents: test() },
];
