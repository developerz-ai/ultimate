// The `verify` job's merge step EXECUTED, not read: the part listing refuses (exit 1) and the
// merge must still run, because the merge IS the run's verdict and a step that aborted before it
// carries none. Split from `ci-workflow-shape.test.ts` at its 500-line ceiling, reading the same
// workflow through `lib/ci-workflow-read.ts`.

import { describe, expect, setDefaultTimeout, test } from 'bun:test';
// why: Bun ships no temp-directory API, no recursive remove, no path join and no chmod.
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expr, jobOf, readWorkflow } from './lib/ci-workflow-read';
import { REPO_SCAN_TIMEOUT_MS } from './lib/run';

setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

const ci = await readWorkflow('ci.yml');

/** The `verify` job's one run block: the listing that feeds the merge, and the merge itself. */
const block =
  (jobOf(ci, 'verify').steps ?? [])
    .map((step) => step.run ?? '')
    .find((run) => run.includes('scripts/verify-parts.ts')) ?? '';

/**
 * The stubs, as PROGRAMS on PATH: the listing refuses (exit 1) and the merge RECORDS that it ran.
 * Only the two commands the block names are stubbed, so the block's own control flow — the `||`,
 * the `mapfile`, the process substitution — is the workflow's and not a rewrite of it.
 */
const STUB_BUN = `#!/bin/sh
case "$2" in
scripts/verify-parts.ts)
  echo "the part listing refused" >&2
  exit 1
  ;;
scripts/verify.ts)
  echo "$*" >> "$DZ_MERGE"
  ;;
esac
exit 0
`;

/** `jq` reads the listing's `--json` document; a listing that refused never wrote one. */
const STUB_JQ = `#!/bin/sh
cat > /dev/null
exit 0
`;

/**
 * The block, run the way the runner runs it: `bash -e` (the workflow's default shell), the
 * runner's `runner.temp` for the one expression it names, and the two commands stubbed. Answers
 * what the merge recorded — empty when the merge never ran.
 */
const runBlock = async (script: string): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'ci-merge-'));
  try {
    for (const [name, body] of [
      ['bun', STUB_BUN],
      ['jq', STUB_JQ],
    ] as const) {
      const path = join(dir, name);
      await Bun.write(path, body);
      await chmod(path, 0o755);
    }
    const child = Bun.spawn(['bash', '-e', '-c', script.replaceAll(expr('runner.temp'), dir)], {
      env: {
        ...process.env,
        PATH: `${dir}:${process.env['PATH'] ?? ''}`,
        DZ_MERGE: join(dir, 'merge'),
        RUNNER_TEMP: dir,
        GITHUB_STEP_SUMMARY: join(dir, 'summary'),
      },
      stdout: 'ignore',
      stderr: 'pipe',
      // The block is a dozen lines of shell; a child that outlives that is the block hanging.
      timeout: 10_000,
    });
    await child.exited;
    const record = Bun.file(join(dir, 'merge'));
    const stderr = await new Response(child.stderr).text();
    return (await record.exists()) ? `${await record.text()}\n${stderr}` : stderr;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

const LISTING = 'bun run scripts/verify-parts.ts';
const MERGE = 'bun run scripts/verify.ts merge';

describe.skipIf(Bun.which('bash') === null)(
  'unit · ci.yml · the merge runs when the part listing refuses',
  () => {
    // The static assertions in `ci-workflow-shape.test.ts` read the block's TEXT: `|| exit 1`
    // satisfies every one of them, and then the listing's refusal aborts the step before the
    // merge — the run carries no verdict at all. This runs the block instead.
    test('a listing that refuses still reaches the merge', async () => {
      const reached = await runBlock(block);
      // The refusal is the STUB's: an unreplaced `${{ … }}` would fail the listing the same way,
      // and say so instead.
      expect(reached).toContain('the part listing refused');
      expect(reached).toContain('merge');
    });

    // The control: the same block with the listing's own handler turned into the refusal the
    // review named. The merge is NOT reached — so the assertion above has teeth, and the guard
    // in the workflow is what makes the difference.
    test('a listing that aborts the step never reaches the merge', async () => {
      const guard = block.indexOf('||', block.indexOf(LISTING));
      const aborted = `${block.slice(0, guard)}|| exit 1;${block.slice(guard + 2)}`;
      // The mutation is the listing's own guard: it lands between the listing and the merge, and
      // the listing's guard is the only `||` there.
      const between = aborted.slice(aborted.indexOf(LISTING), aborted.indexOf(MERGE));
      expect(between).toContain('|| exit 1;');
      expect(await runBlock(aborted)).not.toContain('merge');
    });
  },
);
