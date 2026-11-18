// The migration off vendored guards, over an in-memory app: an identical copy goes, a severity-only
// edit becomes a row, any other edit is kept under a new name with the shipped one off — never
// overwritten — and a second run changes nothing.

import { describe, expect, test } from 'bun:test';
import { SHIPPED_GUARD_CONFIG } from '../guards-built-in';
import { guardFormHash } from '../guards-vendored';
import { repoUnboundedGuardFiles } from '../templates/guard-repo-unbounded';
import {
  SHIPPED_GUARD_NAMES,
  shippedGuardSource,
  shippedGuardTest,
} from '../templates/scaffold-guards';
import { memoryCodemodApp } from './codemod';
import { codemod, vendoredGuardsCodemod } from './vendored-guards';

const rule = (name: string): string => shippedGuardSource(name) ?? '';
const ruleTest = (name: string): string => shippedGuardTest(name) ?? '';

/** Every shipped guard and its test, as `x new` wrote them before guards were built in. */
const vendoredTree = (): Record<string, string> =>
  Object.fromEntries(
    SHIPPED_GUARD_NAMES.flatMap((name) => [
      [`guards/${name}.ts`, rule(name)],
      [`guards/${name}.test.ts`, ruleTest(name)],
    ]),
  );

const severities = (files: Record<string, string>): unknown =>
  JSON.parse(files[SHIPPED_GUARD_CONFIG] ?? 'null')?.severity;

describe('unit · codemod vendored-guards', () => {
  test('identical copies and their tests are deleted; the app opts in with no rows', async () => {
    const app = memoryCodemodApp({ ...vendoredTree(), 'guards/mine.ts': 'export {};\n' });
    const result = await codemod.run(app);
    expect(Object.keys(app.files).sort()).toEqual(['guards/mine.ts', SHIPPED_GUARD_CONFIG]);
    expect(severities(app.files)).toEqual({});
    expect(result.skipped).toEqual([]);
    expect(result.changed).toContain('guards/raw-fetch.ts');
    expect(result.changed).toContain('guards/raw-fetch.test.ts');
  });

  test('a locally edited guard is kept as an app guard, never overwritten, the shipped one off', async () => {
    const edited = rule('raw-fetch').replace(
      "const CODE = 'X_RAW_FETCH';",
      "const CODE = 'X_VENDOR_CALL';",
    );
    expect(edited).not.toBe(rule('raw-fetch'));
    const app = memoryCodemodApp({
      ...vendoredTree(),
      'guards/raw-fetch.ts': edited,
      'x.verify.json': JSON.stringify({ steps: [], guardBaseline: { 'raw-fetch': 2, mine: 1 } }),
    });
    const result = await codemod.run(app);
    expect(app.files['guards/app-raw-fetch.ts']).toBe(edited);
    expect(app.files['guards/raw-fetch.ts']).toBeUndefined();
    expect(app.files['guards/app-raw-fetch.test.ts']).toContain("from './app-raw-fetch'");
    expect(app.files['guards/app-raw-fetch.test.ts']).not.toContain("from './raw-fetch'");
    expect(severities(app.files)).toEqual({ 'raw-fetch': 'off' });
    expect(JSON.parse(app.files['x.verify.json'] ?? '{}').guardBaseline).toEqual({
      'app-raw-fetch': 2,
      mine: 1,
    });
    const [kept] = result.skipped;
    expect(kept?.path).toBe('guards/app-raw-fetch.ts');
    expect(kept?.reason).toContain('kept as your own guard');
    expect(kept?.diff).toContain("+const CODE = 'X_VENDOR_CALL';");
  });

  test('a copy edited only to report becomes a "warning" row, and is deleted', async () => {
    const reportOnly = rule('raw-fetch').replace(
      'export const guard: Guard = {\n',
      "export const guard: Guard = {\n  severity: 'warning',\n",
    );
    expect(reportOnly).toContain("severity: 'warning',");
    const app = memoryCodemodApp({ ...vendoredTree(), 'guards/raw-fetch.ts': reportOnly });
    await codemod.run(app);
    expect(app.files['guards/raw-fetch.ts']).toBeUndefined();
    expect(severities(app.files)).toEqual({ 'raw-fetch': 'warning' });
  });

  test("an older app's report-only repo-unbounded is a current form: a row, not an app guard", async () => {
    const older = String(repoUnboundedGuardFiles('warning')[0]?.contents);
    const app = memoryCodemodApp({ ...vendoredTree(), 'guards/repo-unbounded.ts': older });
    await codemod.run(app);
    expect(app.files['guards/repo-unbounded.ts']).toBeUndefined();
    expect(severities(app.files)).toEqual({ 'repo-unbounded': 'warning' });
  });

  test('a shipped guard a legacy app lacks stays report-only; one that ships report-only needs no row', async () => {
    const tree = vendoredTree();
    for (const name of ['native-confirm', 'repo-await-in-loop']) {
      delete tree[`guards/${name}.ts`];
      delete tree[`guards/${name}.test.ts`];
    }
    const app = memoryCodemodApp(tree);
    await codemod.run(app);
    expect(severities(app.files)).toEqual({ 'native-confirm': 'warning' });
  });

  test('a test the app added cases to is reported with its diff when its shipped rule goes', async () => {
    const app = memoryCodemodApp({
      ...vendoredTree(),
      'guards/raw-fetch.test.ts': `${ruleTest('raw-fetch')}// my case\n`,
    });
    const result = await codemod.run(app);
    expect(app.files['guards/raw-fetch.test.ts']).toBeUndefined();
    expect(result.skipped.map((skip) => skip.path)).toEqual(['guards/raw-fetch.test.ts']);
    expect(result.skipped[0]?.diff).toContain('+// my case');
  });

  test('a second run changes nothing, and an existing row is never overwritten', async () => {
    const app = memoryCodemodApp({
      ...vendoredTree(),
      [SHIPPED_GUARD_CONFIG]: JSON.stringify({ severity: { 'raw-colour': 'off' } }),
    });
    await codemod.run(app);
    expect(severities(app.files)).toEqual({ 'raw-colour': 'off' });
    expect(await codemod.run(app)).toEqual({ changed: [], skipped: [] });
  });

  test('a config it cannot read stops the migration before it touches a file', async () => {
    const app = memoryCodemodApp({ ...vendoredTree(), [SHIPPED_GUARD_CONFIG]: '{' });
    const result = await codemod.run(app);
    expect(result.changed).toEqual([]);
    expect(result.skipped[0]?.path).toBe(SHIPPED_GUARD_CONFIG);
    expect(app.files['guards/raw-fetch.ts']).toBe(rule('raw-fetch'));
  });
});

// A copy an older release wrote and nobody edited is not an edit: deleted, the app takes the
// shipped rule. Without this a 31.4 scaffold kept thirteen frozen app guards with no hand edit made.
describe('unit · codemod vendored-guards · a stale release form', () => {
  const OLD =
    "// raw-fetch as an older release wrote it\nexport const guard = { summary: 'x', check: () => [] };\n";

  test('is deleted with its test, never kept as an app guard', async () => {
    const released = { 'raw-fetch': [[guardFormHash(OLD), 'error']] as const };
    const app = memoryCodemodApp({ ...vendoredTree(), 'guards/raw-fetch.ts': OLD });
    const result = await vendoredGuardsCodemod({ forms: released }).run(app);
    expect(app.files['guards/raw-fetch.ts']).toBeUndefined();
    expect(app.files['guards/app-raw-fetch.ts']).toBeUndefined();
    expect(severities(app.files)).toEqual({});
    expect(result.skipped).toEqual([]);
  });

  test('one released report-only keeps reporting only, as a row', async () => {
    const released = { 'raw-fetch': [[guardFormHash(OLD), 'warning']] as const };
    const app = memoryCodemodApp({ ...vendoredTree(), 'guards/raw-fetch.ts': OLD });
    await vendoredGuardsCodemod({ forms: released }).run(app);
    expect(severities(app.files)).toEqual({ 'raw-fetch': 'warning' });
  });
});

/** `guards/bare-error.ts` exactly as `x new` wrote it at v25.0.0, before any v31 form existed. */
const BARE_ERROR_V25 = `${[
  '// bare-error: a failure this app raises carries a code, a cause and an executable fix.',
  '// `x verify` discovers every file in `guards/` and runs its `guard` inside the `boundaries`',
  '// step — nothing registers this file, so nothing can forget to.',
  '',
  "import type { Finding, Guard } from '@ultimat3/cli';",
  '',
  '/** The app owns the codes its own conventions raise — this one is named for the guard. */',
  "const CODE = 'X_BARE_ERROR';",
  '',
  '/**',
  ' * A THROW, never a construction. `new Error(…)` handed to something as INPUT is legitimate — a',
  ' * test fixture, an `AbortSignal` reason, a rejection this module is passing along — and only the',
  ' * throw is this module stating its own verdict.',
  ' */',
  'const BARE_THROW = /\\bthrow\\s+new\\s+(Error|TypeError|RangeError|SyntaxError)\\s*\\(/g;',
  '',
  'export interface SourceFile {',
  '  /** App-root-relative POSIX path, so the finding names the file an author opens. */',
  '  readonly path: string;',
  '  readonly source: string;',
  '}',
  '',
  '/** Comments blanked IN PLACE — not deleted — so a reported line number still points at the source. */',
  'const blank = (text: string): string =>',
  '  text',
  "    .replaceAll(/\\/\\*[\\s\\S]*?\\*\\//g, (match) => match.replaceAll(/[^\\n]/g, ' '))",
  "    .replaceAll(/(?<![:\\w])\\/\\/[^\\n]*/g, (match) => ' '.repeat(match.length));",
  '',
  "const lineOf = (text: string, index: number): number => text.slice(0, index).split('\\n').length;",
  '',
  '/** Pure — the caller does the I/O — so the rule is testable without a filesystem. */',
  'export function bareThrows(files: readonly SourceFile[]): readonly Finding[] {',
  '  const findings: Finding[] = [];',
  '  for (const file of files) {',
  '    const text = blank(file.source);',
  '    for (const match of text.matchAll(BARE_THROW)) {',
  '      const line = lineOf(text, match.index);',
  "      const thrown = match[1] ?? 'Error';",
  '      findings.push({',
  '        code: CODE,',
  // biome-ignore lint/suspicious/noTemplateCurlyInString: the old scaffold's source, verbatim
  '        cause: `${file.path}:${line} throws a bare ${thrown} — it reaches its reader as a stack trace with no code, no cause and nothing to run`,',
  // biome-ignore lint/suspicious/noTemplateCurlyInString: the old scaffold's source, verbatim
  '        fix: `subclass UltimateError in ${file.path} with an X_SCREAMING_SNAKE code, a cause and a fix naming a command, then: x verify`,',
  '        at: file.path,',
  '      });',
  '    }',
  '  }',
  '  return findings;',
  '}',
  '',
  'export const guard: Guard = {',
  "  summary: 'a failure carries a code, a cause and an executable fix — never a bare Error',",
  '  async check(_root, sources) {',
  '    // A test states its verdict with `expect.unreachable()`, which the suite reports on its own',
  "    // terms. The run's ONE read of the source: every guard asking for this glob shares the walk.",
  "    const code = await sources.files('{apps,packages}/**/*.{ts,tsx}');",
  '    return bareThrows(',
  '      code',
  '        .filter((file) => !/\\.(?:test|d)\\.tsx?$/.test(file.path))',
  '        .map((file) => ({ path: file.path, source: file.text })),',
  '    );',
  '  },',
  '};',
].join('\n')}\n`;

// The committed table, not a test's own: an app keeps its scaffold's copy across majors.
describe('unit · codemod vendored-guards · a copy from before v31', () => {
  test('is deleted with the shipped rule left on, never kept as an edit', async () => {
    const app = memoryCodemodApp({ ...vendoredTree(), 'guards/bare-error.ts': BARE_ERROR_V25 });
    const result = await codemod.run(app);
    expect(app.files['guards/bare-error.ts']).toBeUndefined();
    expect(app.files['guards/app-bare-error.ts']).toBeUndefined();
    expect(severities(app.files)).toEqual({});
    expect(result.skipped).toEqual([]);
  });

  test('one line changed is still the app’s edit: kept, the shipped rule off', async () => {
    const edited = `${BARE_ERROR_V25}// a rule of ours\n`;
    const app = memoryCodemodApp({ ...vendoredTree(), 'guards/bare-error.ts': edited });
    await codemod.run(app);
    expect(app.files['guards/app-bare-error.ts']).toBe(edited);
    expect(severities(app.files)).toEqual({ 'bare-error': 'off' });
  });
});

describe('unit · codemod vendored-guards · a stale release test', () => {
  test('an older release’s test goes with its rule, with no note: nobody added a case', async () => {
    const old = `${ruleTest('raw-fetch')}// as an older release wrote it\n`;
    const app = memoryCodemodApp({ ...vendoredTree(), 'guards/raw-fetch.test.ts': old });
    const result = await vendoredGuardsCodemod({
      tests: { 'raw-fetch': [guardFormHash(old)] },
    }).run(app);
    expect(app.files['guards/raw-fetch.test.ts']).toBeUndefined();
    expect(result.skipped).toEqual([]);
  });
});
