// The `lint` step, against the real biome: a red step names the file, the line and the rule, and its
// fix is one that does something. `bunx biome check --write .` printed "Skipped 1 suggested fixes".

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
// why: Bun has no temp-directory API and no recursive remove.
import { mkdtempSync, rmSync } from 'node:fs';
// why: Bun exposes no tmpdir().
import { tmpdir } from 'node:os';
// why: Bun ships no path joiner.
import { join } from 'node:path';
import { exec } from './exec';
import { lintFindings, lintOutcome } from './lint-findings';
import { workspaceRoot } from './scaffold-typecheck-fixture';
import { VERIFY_STEPS } from './verify-checks';

const BIOME = join(workspaceRoot(), 'node_modules/.bin/biome');
const CONFIG = JSON.stringify({
  files: { includes: ['bad.ts'] },
  linter: { rules: { correctness: { noUnusedVariables: 'error' } } },
});

let root = '';

const check = async () =>
  lintOutcome(
    await exec([BIOME, 'check', '--reporter=json', '--max-diagnostics=none', '.'], { cwd: root }),
  );

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'x-lint-findings-'));
  await Bun.write(join(root, 'biome.json'), CONFIG);
  // Biome holds its own config to its format: a finding about it is not what these read.
  await exec([BIOME, 'check', '--write', 'biome.json'], { cwd: root });
  await Bun.write(join(root, 'bad.ts'), 'const unused = 1;\nexport const used = 2;\n');
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('the lint step', () => {
  test('an unused variable is a finding naming file, line and rule, with an edit as its fix', async () => {
    const outcome = await check();
    expect(outcome.ok).toBe(false);
    expect(outcome.findings).toHaveLength(1);
    const [finding] = outcome.findings;
    expect(finding?.code).toBe('X_LINT_FAILED');
    expect(finding?.at).toBe('bad.ts');
    expect(finding?.cause).toContain('bad.ts:1 lint/correctness/noUnusedVariables');
    // `--write` cannot repair it, so the fix does not claim it can.
    expect(finding?.fix).toStartWith(
      'bunx biome check bad.ts   # lint/correctness/noUnusedVariables: edit bad.ts:1,',
    );
    expect(finding?.fix).not.toContain('--write');
  });

  test('a formatting miss is told --write, and running that line turns it green', async () => {
    await Bun.write(join(root, 'bad.ts'), 'export const used   =   2\n');
    const outcome = await check();
    const fix = outcome.findings[0]?.fix ?? '';
    expect(fix).toBe('bunx biome check --write bad.ts');
    const argv = fix.replace('bunx biome', BIOME).split(' ');
    await exec(argv, { cwd: root });
    expect((await check()).ok).toBe(true);
  });

  test('the step asks biome for the report these read', async () => {
    const asked: (readonly string[])[] = [];
    const step = VERIFY_STEPS.find((one) => one.name === 'lint');
    await step?.run({
      root,
      runner: async (argv: readonly string[]) => {
        asked.push(argv);
        return { command: argv, code: 0, ok: true, stdout: '', stderr: '', durationMs: 0 };
      },
    } as never);
    expect(asked[0]).toContain('--reporter=json');
  });
});

describe('a report that is not one', () => {
  const red = (stdout: string) => ({
    command: [],
    code: 1,
    ok: false,
    stdout,
    stderr: 'biome: bad config',
    durationMs: 1,
  });

  test.each([
    ['not json'],
    ['{"diagnostics":"nope"}'],
    ['{"diagnostics":[]}'],
    ['{"diagnostics":[{"severity":"warning","category":"x","location":{"path":"a.ts"}}]}'],
  ])('%s keeps one finding pointing at the command, with what biome said', (stdout) => {
    const outcome = lintOutcome(red(stdout));
    expect(outcome.ok).toBe(false);
    expect(outcome.findings[0]?.fix).toBe('bunx biome check .');
    expect(outcome.output).toContain('bad config');
  });

  test('a path the shell would read is quoted', () => {
    const report = JSON.stringify({
      diagnostics: [
        { severity: 'error', category: 'format', message: 'm', location: { path: 'a;id.ts' } },
      ],
    });
    expect(lintFindings(report)?.[0]?.fix).toBe("bunx biome check --write 'a;id.ts'");
  });
});
