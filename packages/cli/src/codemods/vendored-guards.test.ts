// The migration off vendored guards, over an in-memory app: an identical copy goes, a severity-only
// edit becomes a row, any other edit is kept under a new name with the shipped one off — never
// overwritten — and a second run changes nothing.

import { describe, expect, test } from 'bun:test';
import { SHIPPED_GUARD_CONFIG } from '../guards-built-in';
import { repoUnboundedGuardFiles } from '../templates/guard-repo-unbounded';
import {
  SHIPPED_GUARD_NAMES,
  shippedGuardSource,
  shippedGuardTest,
} from '../templates/scaffold-guards';
import { memoryCodemodApp } from './codemod';
import { codemod } from './vendored-guards';

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
