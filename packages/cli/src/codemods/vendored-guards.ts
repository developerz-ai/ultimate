// Carries an app off vendored copies of shipped guards, once: every shipped guard runs from the
// installed framework now (`guards-built-in.ts`). An identical copy is deleted; one that differs
// only in severity becomes a `guards/shipped.json` row; any other edit is kept as the app's own
// guard under a new name, the shipped one turned off, with the reason and the diff — never lost.

import { sameText } from '../doctor-guards';
import {
  parseShippedConfig,
  SHIPPED_GUARD_CONFIG,
  SHIPPED_SEVERITY_FIELD,
  type ShippedSeverity,
  vendoredPath,
} from '../guards-built-in';
import {
  SHIPPED_GUARD_NAMES,
  shippedGuardForms,
  shippedGuardTest,
} from '../templates/scaffold-guards';
import { VERIFY_FLOOR_FILE } from '../verify-floor';
import { GUARD_BASELINE_FIELD } from '../verify-guard-baseline';
import type { Codemod, CodemodApp, CodemodResult } from './codemod';
import { unifiedDiff } from './engine-diff';

/** The severity line a report-only guard carries; stripped, two copies differing only there match. */
const SEVERITY_LINE = /^\s*severity:\s*'warning',\s*\n/gm;
const REPORT_ONLY = /^\s*severity:\s*'warning',\s*$/m;
const withoutSeverity = (text: string): string =>
  text.replaceAll('\r\n', '\n').replaceAll(SEVERITY_LINE, '');

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** What one copy becomes: deleted at a severity, or kept as the app's own guard. */
type Verdict =
  | { readonly kind: 'delete'; readonly severity: 'error' | 'warning' }
  | { readonly kind: 'keep' };

/** The copy against every current form of its guard: exact, then exact but for severity. */
const judge = (name: string, copy: string): Verdict => {
  const forms = shippedGuardForms(name);
  const exact = forms.find((form) => sameText(copy, form.source));
  if (exact !== undefined) return { kind: 'delete', severity: exact.severity };
  const bare = withoutSeverity(copy);
  if (forms.some((form) => withoutSeverity(form.source) === bare)) {
    return { kind: 'delete', severity: REPORT_ONLY.test(copy) ? 'warning' : 'error' };
  }
  return { kind: 'keep' };
};

/** `guards/app-<name>.ts`, or the first `app-<name>-<n>` the app does not already hold. */
const freeName = async (app: CodemodApp, name: string): Promise<string> => {
  for (let n = 1; ; n += 1) {
    const candidate = n === 1 ? `app-${name}` : `app-${name}-${String(n)}`;
    if (!(await app.exists(`guards/${candidate}.ts`))) return candidate;
  }
};

/** A baseline written for the shipped name follows its rule to the new one, or it goes stale. */
const moveBaselines = async (
  app: CodemodApp,
  renamed: ReadonlyMap<string, string>,
): Promise<boolean> => {
  const text = await app.read(VERIFY_FLOOR_FILE);
  if (text === undefined || renamed.size === 0) return false;
  let floor: unknown;
  try {
    floor = JSON.parse(text);
  } catch {
    return false;
  }
  const baseline = isRecord(floor) ? floor[GUARD_BASELINE_FIELD] : undefined;
  if (!isRecord(floor) || !isRecord(baseline)) return false;
  const moved = Object.fromEntries(
    Object.entries(baseline).map(([key, value]) => [renamed.get(key) ?? key, value]),
  );
  if (Object.keys(baseline).every((key) => !renamed.has(key))) return false;
  await app.write(
    VERIFY_FLOOR_FILE,
    `${JSON.stringify({ ...floor, [GUARD_BASELINE_FIELD]: moved }, null, 2)}\n`,
  );
  return true;
};

async function run(app: CodemodApp): Promise<CodemodResult> {
  const changed: string[] = [];
  const skipped: CodemodResult['skipped'] = [];
  const configText = await app.read(SHIPPED_GUARD_CONFIG);
  const parsed = configText === undefined ? undefined : parseShippedConfig(configText);
  if (parsed !== undefined && parsed.problems.length > 0) {
    const reason = `${SHIPPED_GUARD_CONFIG} does not parse (${parsed.problems.join('; ')}): fix it, then x upgrade again`;
    return { changed, skipped: [{ path: SHIPPED_GUARD_CONFIG, reason }] };
  }
  const rows: Record<string, ShippedSeverity> = { ...(parsed?.severity ?? {}) };
  const held = (await app.glob('guards/*.{ts,tsx}')).filter(
    (path) => !/\.(?:test|d)\.tsx?$/.test(path),
  );
  const renamed = new Map<string, string>();
  for (const name of SHIPPED_GUARD_NAMES) {
    const path = vendoredPath(held, name);
    const own = shippedGuardForms(name)[0]?.severity ?? 'error';
    if (path === undefined) {
      // A legacy app never had this guard gate it: it keeps reporting only, until the author says.
      if (configText === undefined && own === 'error' && rows[name] === undefined) {
        rows[name] = 'warning';
      }
      continue;
    }
    const copy = (await app.read(path)) ?? '';
    const testPath = `guards/${name}.test.ts`;
    const test = await app.read(testPath);
    const verdict = judge(name, copy);
    if (verdict.kind === 'delete') {
      await app.remove(path);
      changed.push(path);
      if (verdict.severity !== own && rows[name] === undefined) rows[name] = verdict.severity;
      if (test !== undefined) {
        await app.remove(testPath);
        changed.push(testPath);
        const shipped = shippedGuardTest(name) ?? '';
        if (!sameText(test, shipped)) {
          skipped.push({
            path: testPath,
            reason: `deleted with its rule, which is the shipped one and tested by the framework now; a case you added is in the diff — carry it to a test of your own`,
            diff: unifiedDiff(testPath, shipped, test),
          });
        }
      }
      continue;
    }
    const next = await freeName(app, name);
    const nextPath = `guards/${next}${path.endsWith('.tsx') ? '.tsx' : '.ts'}`;
    await app.write(nextPath, copy);
    await app.remove(path);
    changed.push(path, nextPath);
    if (test !== undefined) {
      const nextTest = `guards/${next}.test.ts`;
      await app.write(nextTest, test.replaceAll(`from './${name}'`, `from './${next}'`));
      await app.remove(testPath);
      changed.push(testPath, nextTest);
    }
    rows[name] = 'off';
    renamed.set(name, next);
    skipped.push({
      path: nextPath,
      reason: `${path} is not a form of the shipped ${name} guard and not one a ${SHIPPED_GUARD_CONFIG} row can say, so it is kept as your own guard ${nextPath} and the shipped one is "off" — delete ${nextPath} and that row to take the shipped rule`,
      diff: unifiedDiff(path, shippedGuardForms(name)[0]?.source ?? '', copy),
    });
  }
  if (await moveBaselines(app, renamed)) changed.push(VERIFY_FLOOR_FILE);
  // Written when absent — its presence is the opt-in — or when a row moved; never reformatted.
  const sorted = Object.entries(rows).sort(([a], [b]) => (a < b ? -1 : 1));
  const before = Object.entries(parsed?.severity ?? {}).sort(([a], [b]) => (a < b ? -1 : 1));
  if (configText === undefined || JSON.stringify(sorted) !== JSON.stringify(before)) {
    const severity = Object.fromEntries(sorted);
    await app.write(
      SHIPPED_GUARD_CONFIG,
      `${JSON.stringify({ [SHIPPED_SEVERITY_FIELD]: severity }, null, 2)}\n`,
    );
    changed.push(SHIPPED_GUARD_CONFIG);
  }
  return { changed, skipped };
}

export const codemod: Codemod = {
  id: 'vendored-guards',
  since: '31.28.0',
  summary:
    'shipped guards run from the installed framework: identical copies in guards/ deleted, an edit kept as a guards/shipped.json row or an app guard',
  run,
};
