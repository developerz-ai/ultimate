// `x g guard <name>` — the app's own convention, scaffolded as a build error. Not a primitive and
// not a check the framework owns: what the emitted file has to get right is the directory (it is
// the registration), the exported `guard` the gate looks for, and a rule that fires on something
// real, so an author replacing the example knows what a working one looks like.

import type { GeneratedFile } from './naming';
import { kebab } from './naming';

/**
 * The code the emitted guard raises, derived from its name — the same shape `x g action` derives
 * `X_<FEATURE>_NOT_FOUND` in. Derived and never written as a literal here for the same reason: an
 * `X_*` literal in framework source is a framework code, and it would have to be registered and
 * documented in `wiki/Error-Codes.md`. The app owns the codes its own conventions raise.
 */
export const guardCode = (name: string): string =>
  `X_${kebab(name).toUpperCase().split('-').join('_')}`;

const guardSource = (
  name: string,
): string => `// ${name}: one convention this app enforces, as a build error. \`x verify\` discovers every file in
// \`guards/\` and runs its \`guard\` inside the \`boundaries\` step — nothing registers this file, so
// nothing can forget to. Replace the rule below with the one this app needs; the shape is the
// contract, and the findings it returns are what \`--json\` and the exit code are made of.

import type { Finding, Guard } from '@ultimat3/cli';

/**
 * The example rule, and the class of failure a guard exists for: a migration that adds a NOT NULL
 * column with no DEFAULT applies cleanly to an empty local database and fails on the first
 * production table that already holds rows. Nothing else in the gate can see it — \`x verify\`'s
 * \`drift\` step reads these same files and asks a different question (is every destructive
 * statement declared?), and a test suite runs against a database this statement has never met.
 *
 * The code is this guard's own name: the line an agent reads has to say WHICH convention broke, so
 * a guard is named after its convention and the two are renamed together.
 */
const CODE = '${guardCode(name)}';

/** A column definition begins at \`add column\` and ends at the comma or semicolon after it. */
const ADD_COLUMN = /add\\s+column\\s+(?:if\\s+not\\s+exists\\s+)?"?([\\w]+)"?([^,;]*)/gi;

export interface MigrationFile {
  /** App-root-relative POSIX path, so the finding names the file an author opens. */
  readonly path: string;
  readonly sql: string;
}

/**
 * Pure — the caller does the I/O — so the rule is testable without a filesystem, which is the same
 * split the framework's own checks use. A guard returns findings and nothing else: it never
 * prints, never throws for a normal result and never decides the exit code.
 */
export function unsafeAdditions(files: readonly MigrationFile[]): readonly Finding[] {
  const findings: Finding[] = [];
  for (const file of files) {
    // Line comments first: \`-- add column slug text not null\` in a note is not a statement.
    for (const statement of file.sql.replaceAll(/--[^\\n]*/g, ' ').split(';')) {
      if (!/\\balter\\s+table\\b/i.test(statement)) continue;
      for (const match of statement.matchAll(ADD_COLUMN)) {
        const definition = match[2] ?? '';
        if (!/\\bnot\\s+null\\b/i.test(definition)) continue;
        if (/\\bdefault\\b/i.test(definition)) continue;
        const column = match[1] ?? 'the column';
        findings.push({
          code: CODE,
          cause: \`\${file.path} adds \${column} NOT NULL with no DEFAULT — every row already in the table violates it the moment this runs against data\`,
          fix: \`give \${column} a DEFAULT in \${file.path}, then: x db migrate\`,
          at: file.path,
        });
      }
    }
  }
  return findings;
}

export const guard: Guard = {
  summary: 'a migration never adds a NOT NULL column without a DEFAULT',
  async check(root) {
    const files: MigrationFile[] = [];
    for await (const path of new Bun.Glob('packages/db/migrations/*.sql').scan({
      cwd: root,
      absolute: false,
    })) {
      files.push({ path, sql: await Bun.file(\`\${root}/\${path}\`).text() });
    }
    return unsafeAdditions(files);
  },
};
`;

const guardTest = (
  name: string,
): string => `// The rule, driven directly. Failure case first: a guard whose rule silently stopped matching is
// a green gate over the convention it was written to enforce.

import { expect, unitTest } from '@ultimat3/testing';
import { unsafeAdditions } from './${name}';

const migration = (sql: string) => [{ path: 'packages/db/migrations/0002_probe.sql', sql }];

unitTest('a NOT NULL column added with no DEFAULT is refused', () => {
  const findings = unsafeAdditions(migration('ALTER TABLE posts ADD COLUMN slug text NOT NULL;'));
  expect(findings).toHaveLength(1);
  expect(findings[0]?.at).toBe('packages/db/migrations/0002_probe.sql');
  expect(findings[0]?.cause).toContain('slug');
});

unitTest('a DEFAULT makes the same addition safe', () => {
  const sql = "ALTER TABLE posts ADD COLUMN slug text NOT NULL DEFAULT '';";
  expect(unsafeAdditions(migration(sql))).toHaveLength(0);
});

unitTest('a nullable column was always safe, and a new table is not an addition', () => {
  expect(unsafeAdditions(migration('ALTER TABLE posts ADD COLUMN slug text;'))).toHaveLength(0);
  expect(unsafeAdditions(migration('CREATE TABLE posts (slug text NOT NULL);'))).toHaveLength(0);
});
`;

/** `guards/<name>.ts` and its test. No index, no registry, no manifest row — the directory is it. */
export function guardFiles(rawName: string): readonly GeneratedFile[] {
  const name = kebab(rawName);
  return [
    { path: `guards/${name}.ts`, contents: guardSource(name) },
    { path: `guards/${name}.test.ts`, contents: guardTest(name) },
  ];
}
