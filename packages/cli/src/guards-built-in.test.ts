// Shipped guards run from the installed framework: an app with no copy still gets every one, its
// own guards run beside them, a copy it still holds wins with a warning, and `guards/shipped.json`
// is the one place an app changes how a shipped guard reports.

import { describe, expect, test } from 'bun:test';
// why: Bun ships no temp-directory API; `mkdtemp`/`rm` own a throwaway app root's lifetime.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.write takes one already joined.
import { join } from 'node:path';
import { guardReport } from './guards';
import {
  GUARD_VENDORED_CODE,
  materializeGuard,
  parseShippedConfig,
  planBuiltIns,
  SHIPPED_GUARD_CONFIG,
} from './guards-built-in';
import { SHIPPED_GUARD_NAMES, shippedGuardSource } from './templates/scaffold-guards';
import { VERIFY_FLOOR_FILE } from './verify-floor';

/** A server fetch with no signal: `raw-fetch` reports it, and nothing else shipped does. */
const FETCH = { 'apps/web/api/vendor.ts': "export const ping = () => fetch('https://a.test');\n" };

/** A `repo.ts` awaiting per loop turn: `repo-await-in-loop`, report-only by its own declaration. */
const LOOP = {
  'packages/db/src/posts/repo.ts':
    'export async function all(ids: string[]) {\n  for (const id of ids) {\n    await db.posts.find(id);\n  }\n}\n',
};

const OWN_GUARD = `export const guard = {
  summary: 'the app rule',
  check: () => [{ code: 'X_APP_RULE', cause: 'apps/web/app/a.ts breaks it', fix: 'x g action a' }],
};
`;

const withApp = async (
  files: Readonly<Record<string, string>>,
  body: (root: string) => Promise<void>,
): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), 'x-guards-built-in-'));
  try {
    // The one pin `runtime-pin` asks of every app, so only the case's own guard speaks.
    await Bun.write(join(root, 'package.json'), JSON.stringify({ engines: { bun: '1.4.4' } }));
    for (const [path, contents] of Object.entries(files)) {
      await Bun.write(join(root, path), contents);
    }
    await body(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

const codes = (findings: readonly { readonly code: string }[]): readonly string[] =>
  findings.map((finding) => finding.code);

const config = (severity: Record<string, string> = {}): string => JSON.stringify({ severity });

describe('unit · shipped guards run from the installed framework', () => {
  test('an app holding only guards/shipped.json still gets every shipped guard, gating', async () => {
    await withApp({ [SHIPPED_GUARD_CONFIG]: config(), ...FETCH }, async (root) => {
      const report = await guardReport(root);
      expect(codes(report.findings)).toEqual(['X_RAW_FETCH']);
      expect(report.findings[0]?.at).toBe('apps/web/api/vendor.ts:1');
      expect(report.warnings).toEqual([]);
    });
  });

  test('an app with no guards/ at all gets every shipped guard too — report-only on main', async () => {
    await withApp({ ...FETCH }, async (root) => {
      const report = await guardReport(root);
      expect(report.findings).toEqual([]);
      expect(codes(report.warnings)).toEqual(['X_RAW_FETCH']);
    });
  });

  test("the app's own guard runs beside them", async () => {
    await withApp(
      { [SHIPPED_GUARD_CONFIG]: config(), 'guards/app-rule.ts': OWN_GUARD, ...FETCH },
      async (root) => {
        expect(codes((await guardReport(root)).findings)).toEqual(['X_APP_RULE', 'X_RAW_FETCH']);
      },
    );
  });

  test('a vendored copy wins, runs once, and a warning says it is built in now', async () => {
    const edited = (shippedGuardSource('raw-fetch') ?? '').replace(
      "const CODE = 'X_RAW_FETCH';",
      "const CODE = 'X_RAW_FETCH_LOCAL';",
    );
    expect(edited).toContain('X_RAW_FETCH_LOCAL');
    await withApp(
      { [SHIPPED_GUARD_CONFIG]: config(), 'guards/raw-fetch.ts': edited, ...FETCH },
      async (root) => {
        const report = await guardReport(root);
        expect(codes(report.findings)).toEqual(['X_RAW_FETCH_LOCAL']);
        expect(codes(report.warnings)).toEqual([GUARD_VENDORED_CODE]);
        expect(report.warnings[0]?.cause).toContain('(raw-fetch)');
        expect(report.warnings[0]?.fix).toStartWith('x upgrade');
      },
    );
  });
});

describe('unit · guards/shipped.json — one row per shipped guard', () => {
  test('"off" does not run it', async () => {
    await withApp(
      { [SHIPPED_GUARD_CONFIG]: config({ 'raw-fetch': 'off' }), ...FETCH },
      async (root) => {
        const report = await guardReport(root);
        expect([...report.findings, ...report.warnings]).toEqual([]);
      },
    );
  });

  test('"warning" lists it and never fails', async () => {
    await withApp(
      { [SHIPPED_GUARD_CONFIG]: config({ 'raw-fetch': 'warning' }), ...FETCH },
      async (root) => {
        const report = await guardReport(root);
        expect(report.findings).toEqual([]);
        expect(codes(report.warnings)).toEqual(['X_RAW_FETCH']);
      },
    );
  });

  test('"error" gates a guard that ships report-only; absent, it stays report-only', async () => {
    await withApp({ [SHIPPED_GUARD_CONFIG]: config(), ...LOOP }, async (root) => {
      const report = await guardReport(root);
      expect(report.findings).toEqual([]);
      expect(codes(report.warnings)).toEqual(['X_REPO_AWAIT_IN_LOOP']);
    });
    await withApp(
      { [SHIPPED_GUARD_CONFIG]: config({ 'repo-await-in-loop': 'error' }), ...LOOP },
      async (root) => {
        expect(codes((await guardReport(root)).findings)).toEqual(['X_REPO_AWAIT_IN_LOOP']);
      },
    );
  });

  test('a row the gate cannot read is red, never ignored', async () => {
    await withApp({ [SHIPPED_GUARD_CONFIG]: config({ 'raw-fecth': 'off' }) }, async (root) => {
      const findings = (await guardReport(root)).findings;
      expect(codes(findings)).toEqual(['X_CONFIG_INVALID']);
      expect(findings[0]?.cause).toContain('"raw-fecth", not a shipped guard');
      expect(findings[0]?.at).toBe(SHIPPED_GUARD_CONFIG);
    });
  });

  test("x.verify.json's guardBaseline holds a built-in by its name, like any guard", async () => {
    const floor = JSON.stringify({ steps: [], guardBaseline: { 'raw-fetch': 1 } });
    await withApp(
      { [SHIPPED_GUARD_CONFIG]: config(), [VERIFY_FLOOR_FILE]: floor, ...FETCH },
      async (root) => {
        const report = await guardReport(root);
        expect(report.findings).toEqual([]);
        expect(codes(report.warnings)).toEqual(['X_RAW_FETCH']);
      },
    );
    // Off, the guard does not run, so the baseline holds slack for nothing.
    await withApp(
      {
        [SHIPPED_GUARD_CONFIG]: config({ 'raw-fetch': 'off' }),
        [VERIFY_FLOOR_FILE]: floor,
        ...FETCH,
      },
      async (root) => {
        expect(codes((await guardReport(root)).findings)).toEqual(['X_GUARD_BASELINE_STALE']);
      },
    );
  });

  test('the parser: every problem named, every good row kept', () => {
    const parsed = parseShippedConfig(
      JSON.stringify({
        severity: { 'raw-fetch': 'off', 'bare-error': 'loud', mine: 'off' },
        extra: 1,
      }),
    );
    expect(parsed.severity).toEqual({ 'raw-fetch': 'off' });
    expect(parsed.problems).toHaveLength(3);
    expect(parseShippedConfig('{').problems).toEqual(['it does not parse as JSON']);
    expect(parseShippedConfig('{}')).toEqual({ severity: {}, problems: [] });
  });

  test('the plan: a copy is vendored, an absent config is legacy, a row is its mode', () => {
    const plan = planBuiltIns(['guards/raw-fetch.ts', 'guards/mine.ts'], undefined);
    expect(plan.vendored).toEqual(['raw-fetch']);
    expect(plan.builtIn).toHaveLength(SHIPPED_GUARD_NAMES.length - 1);
    expect(new Set(plan.builtIn.map((guard) => guard.mode))).toEqual(new Set(['legacy']));
    const rows = planBuiltIns([], { 'raw-fetch': 'off', 'bare-error': 'warning' }).builtIn;
    expect(rows.find((guard) => guard.name === 'raw-fetch')).toBeUndefined();
    expect(rows.find((guard) => guard.name === 'bare-error')?.mode).toBe('warning');
    expect(rows.find((guard) => guard.name === 'raw-colour')?.mode).toBe('default');
  });

  test("a built-in's module is its template's text, under the app's ignored .x/", async () => {
    await withApp({}, async (root) => {
      const path = await materializeGuard(root, 'raw-fetch');
      expect(path.startsWith(join(root, '.x', 'cache', 'guards'))).toBe(true);
      expect(await Bun.file(path).text()).toBe(shippedGuardSource('raw-fetch') ?? '');
      // Asked again: the same path, so a long-lived process imports it once.
      expect(await materializeGuard(root, 'raw-fetch')).toBe(path);
    });
  });
});
