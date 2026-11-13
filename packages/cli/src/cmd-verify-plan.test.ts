// `x verify plan` reads nothing from an app, so it answers outside one: ci.yml's `tested` job runs
// it at the repo root. Every other `x verify` form still refuses there with X_NOT_IN_APP. Driven
// through `dispatch`, which enforces a spec's `requiresApp` before the command runs.

import { afterAll, describe, expect, test } from 'bun:test';
// why: Bun has no temp-directory API and no recursive remove.
import { mkdtempSync, rmSync } from 'node:fs';
// why: Bun exposes no tmpdir().
import { tmpdir } from 'node:os';
import { REQUIRED_BUN } from './app-root';
import { dispatch } from './dispatch';
import { planMatrix, verifyPlan } from './verify-plan';

/** No app.config.ts at or above it: what the repo root is to `findAppRoot`. */
const outside = mkdtempSync(`${tmpdir()}/verify-plan-outside-`);
afterAll(() => rmSync(outside, { recursive: true, force: true }));

interface Document {
  readonly ok: boolean;
  readonly command?: string;
  readonly data?: unknown;
  readonly findings?: readonly { readonly code: string }[];
}

const run = async (argv: readonly string[]): Promise<{ code: number; doc: Document }> => {
  const lines: string[] = [];
  const code = await dispatch({
    argv: [...argv, '--json'],
    cwd: outside,
    env: {},
    bunVersion: REQUIRED_BUN,
    write: (line) => lines.push(line),
  });
  return { code, doc: JSON.parse(lines.join('\n')) as Document };
};

describe('unit · x verify plan · answers outside an app', () => {
  test('the plan is the same document with no app root to find', async () => {
    const { code, doc } = await run(['verify', 'plan', '--parts', '7']);
    expect(doc.findings ?? []).toEqual([]);
    expect(code).toBe(0);
    expect(doc.command).toBe('verify plan');
    expect(doc.data).toEqual({ parts: 7, matrix: planMatrix(verifyPlan(7)) });
  });

  // The flag is read AFTER the root: `--only bogus` outside an app is about the directory.
  test('merge and a run still refuse there, before any flag of theirs is read', async () => {
    for (const argv of [['verify', 'merge', 'part.json'], ['verify'], ['verify', '--only', 'x']]) {
      const { code, doc } = await run(argv);
      expect([argv.join(' '), code, doc.findings?.[0]?.code]).toEqual([
        argv.join(' '),
        1,
        'X_NOT_IN_APP',
      ]);
    }
  });
});
