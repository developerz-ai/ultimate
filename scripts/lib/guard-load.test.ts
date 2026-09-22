// A guard whose imports fail to link must answer `X_GUARD_LOAD_FAILED` with the module named — not
// a bare SyntaxError — and a guard that fails for any OTHER reason must fail exactly as before.
// Proven by spawning real processes, because the failure being caught happens before a script's
// first line runs and cannot be reproduced in-process.

import { afterAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
// why: Bun has no mkdtemp; a unique directory per run keeps parallel test workers apart.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
// why: Bun has no tmpdir() of its own; node:os is the only way to find the platform temp root.
import { tmpdir } from 'node:os';
import { loadFailureOf, loadFinding } from './guard-load';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './run';

// Reads the real tree or spawns real processes, so it runs on the repo-scan backstop.
setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

const ROOT = repoRoot();
const PRELOAD = `${ROOT}/scripts/lib/guard-preload.ts`;

describe('which failures are load failures', () => {
  test('an export a module does not have, named by the module that lacks it', () => {
    const error = new SyntaxError(
      `Export named 'hasEntityRows' not found in module '${ROOT}/packages/entity/src/index.ts'.`,
    );
    expect(loadFailureOf(error)?.module).toBe(`${ROOT}/packages/entity/src/index.ts`);
  });

  test('a module that cannot be resolved, named by the file that asked for it', () => {
    const error = {
      message: `Cannot find module './hooks' from '${ROOT}/packages/realtime/src/index.ts'`,
    };
    expect(loadFailureOf(error)?.module).toBe(`${ROOT}/packages/realtime/src/index.ts`);
  });

  test('a dynamic import that cannot be resolved, as Bun words it for import()', () => {
    const error = {
      message: `Cannot find module './registry' imported from ${ROOT}/packages/cli/src/fix-command.ts`,
    };
    expect(loadFailureOf(error)?.module).toBe(`${ROOT}/packages/cli/src/fix-command.ts`);
  });

  test('a guard`s own error is not one — it keeps its own rendering', () => {
    expect(loadFailureOf(new TypeError('x is undefined'))).toBeUndefined();
    expect(loadFailureOf('Export named')).toBeUndefined();
  });

  test('the finding names the module repo-relative and says what to run next', () => {
    const finding = loadFinding(
      'gate-codes',
      {
        module: `${ROOT}/packages/entity/src/index.ts`,
        message: `Export named 'x' not found in module '${ROOT}/packages/entity/src/index.ts'`,
      },
      ROOT,
    );
    expect(finding.code).toBe('X_GUARD_LOAD_FAILED');
    expect(finding.at).toBe('packages/entity/src/index.ts');
    expect(finding.cause).not.toContain(ROOT);
    expect(finding.fix).toBe(
      'edit packages/entity/src/index.ts until bun run typecheck is clean, then rerun: bun run gate-codes',
    );
  });
});

const made: string[] = [];
afterAll(async () => {
  for (const dir of made) await rm(dir, { recursive: true, force: true });
});

/** A throwaway `scripts/` directory holding one guard and the module it imports. */
async function fixture(guard: string): Promise<string> {
  const dir = await mkdtemp(`${tmpdir()}/guard-load-`);
  made.push(dir);
  await mkdir(`${dir}/scripts`);
  await writeFile(`${dir}/scripts/lib-module.ts`, 'export const present = 1;\n');
  await writeFile(`${dir}/scripts/fixture-guard.ts`, guard);
  return `${dir}/scripts/fixture-guard.ts`;
}

const run = (entry: string) =>
  Bun.spawnSync(['bun', '--preload', PRELOAD, entry, '--json'], { stdout: 'pipe', stderr: 'pipe' });

describe('a guard run under the preload', () => {
  test('a static import that fails to link is X_GUARD_LOAD_FAILED on stdout, exit 1', async () => {
    const entry = await fixture("import { absent } from './lib-module';\nconsole.log(absent);\n");
    const result = run(entry);
    expect(result.exitCode).toBe(1);
    const document = JSON.parse(result.stdout.toString()) as {
      readonly script: string;
      readonly findings: readonly { readonly code: string; readonly at: string }[];
    };
    expect(document.script).toBe('fixture-guard');
    expect(document.findings.map((one) => one.code)).toEqual(['X_GUARD_LOAD_FAILED']);
    expect(document.findings[0]?.at).toEndWith('scripts/lib-module.ts');
  });

  test('a guard that throws for any other reason fails exactly as it did — no code invented', async () => {
    const entry = await fixture(
      "import { present } from './lib-module';\nthrow new TypeError('bad ' + present);\n",
    );
    const result = run(entry);
    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).not.toContain('X_GUARD_LOAD_FAILED');
    expect(result.stderr.toString()).toContain('bad 1');
  });

  test('a guard`s own dynamic import is caught by loadOrReport the same way', async () => {
    const loader = `${ROOT}/scripts/lib/guard-load.ts`;
    const entry = await fixture(
      `import { loadOrReport } from '${loader}';\nawait loadOrReport('fixture-guard', () => import('./lib-module').then((m) => (m as Record<string, unknown>)['absent'] ?? import('./missing-module')));\n`,
    );
    const result = Bun.spawnSync(['bun', entry, '--json'], { stdout: 'pipe', stderr: 'pipe' });
    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toContain('X_GUARD_LOAD_FAILED');
  });
});
