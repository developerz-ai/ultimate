// The order rule on a `fix:` line: the edit an agent must make leads, and the re-run follows it.
// A fix that opens with the failing command and hides the edit in `# after …` is pasted first and
// read second; one that says only "re-run" names nothing to change. Ratcheted per file.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises'; // why: Bun has no mkdtemp and no recursive remove.
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';
import { checkErrorFixes, checkErrorFixReport } from './error-contract';
import { FIX_SEQUENCE_BASELINE, fixSequenceProblem, generatorForceProblem } from './fix-sequence';

describe('fixSequenceProblem', () => {
  test('a command followed by "# after <edit>" defers the edit past the paste', () => {
    expect(fixSequenceProblem('x verify --json   # after deleting .sensitive() in a.ts')).toContain(
      '# after',
    );
    expect(fixSequenceProblem('x jobs retry <id>   # once the compensate is repaired')).toContain(
      '# once',
    );
  });

  test('a fix that only re-runs names nothing to change', () => {
    expect(fixSequenceProblem('fix the underlying failure named in cause, then re-run')).toContain(
      're-run',
    );
    expect(fixSequenceProblem('re-run the command')).toContain('re-run');
  });

  test('the edit first, then the command, is the shape it asks for', () => {
    expect(
      fixSequenceProblem(
        "add retain: { on: 'createdAt' } to entity('posts'), then: x db gen \"retain\"",
      ),
    ).toBeUndefined();
    expect(fixSequenceProblem('set S3_REGION=eu-west-1 in .env, then re-run')).toBeUndefined();
    expect(
      fixSequenceProblem('x routes --json   # /api/* is an action or a query'),
    ).toBeUndefined();
    // A URL fragment and a frequency are not a deferred edit (an app's file has no allowance).
    expect(fixSequenceProblem('open https://example.com/wiki/Upgrading#after-31')).toBeUndefined();
    expect(fixSequenceProblem('x db migrate   # once per environment')).toBeUndefined();
    // "once," is a frequency, not a precondition.
    expect(
      fixSequenceProblem('defineVerificationPurpose({ name })   # once, at boot'),
    ).toBeUndefined();
  });
});

// FX2: a slice's `policy.ts` is shared by every generator that writes into the slice, and the fix
// `x g policy … --force` replaced the first permission with the second. A printed fix is pasted
// without a diff in front of it, so `--force` on a generator is never one.
describe('generatorForceProblem', () => {
  test('refuses --force on an x g command in the runnable half', () => {
    expect(generatorForceProblem('x g policy posts --force --json')).toContain('--force');
    expect(generatorForceProblem('bunx x generate route posts --force')).toContain('--force');
  });

  test('leaves other commands, and prose behind the comment, alone', () => {
    expect(generatorForceProblem('x g policy posts --json')).toBeUndefined();
    expect(generatorForceProblem('git push --force-with-lease')).toBeUndefined();
    expect(generatorForceProblem('x db gen "drop" --allow-destructive')).toBeUndefined();
    expect(
      generatorForceProblem('git diff -- templates/   # then a row naming x g guard NAME --force'),
    ).toBeUndefined();
  });
});

describe('the ratchet, over a repo', () => {
  let root = '';
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'fix-sequence-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test('an app has no allowance: one deferred edit is X_ERROR_FIX_INVALID at its line', async () => {
    await Bun.write(
      join(root, 'packages/db/src/thing.ts'),
      "throw new E({\n  fix: 'x db migrate --json   # after editing entity.ts',\n});\n",
    );
    const findings = await checkErrorFixes(root);
    expect(findings.map((f) => [f.code, f.at])).toEqual([
      ['X_ERROR_FIX_INVALID', 'packages/db/src/thing.ts:2'],
    ]);
    expect(findings[0]?.fix).toContain('packages/db/src/thing.ts:2');
  });

  test('a forced generator fix is refused in every file, with no allowance', async () => {
    const [[path] = ['']] = [...FIX_SEQUENCE_BASELINE];
    await Bun.write(join(root, path), "throw new E({ fix: 'x g policy posts --force --json' });\n");
    const findings = await checkErrorFixes(root);
    expect(findings.map((f) => [f.code, f.at])).toEqual([['X_ERROR_FIX_INVALID', `${path}:1`]]);
    expect(findings[0]?.cause).toContain('--force');
  });

  test('a file within its recorded allowance passes; one past it fails', async () => {
    const [[path, allowed] = ['', 0]] = [...FIX_SEQUENCE_BASELINE];
    const line = "  new E({ fix: 'x db migrate --json   # after editing entity.ts' }),\n";
    await Bun.write(join(root, path), `export const a = [\n${line.repeat(allowed)}];\n`);
    expect(await checkErrorFixes(root)).toEqual([]);
    await Bun.write(join(root, path), `export const a = [\n${line.repeat(allowed + 1)}];\n`);
    expect((await checkErrorFixes(root)).length).toBeGreaterThan(0);
  });
});

// A ratchet with slack lets a rewritten line back in. No `X_*` code says "allowance above the count"
// for the step (a new one is the coordinator's), so tightness is held here: the table EQUALS what
// the step refuses across this repo and its three tracked apps — lower an entry, never leave slack.
describe('the baseline is tight', () => {
  const repo = join(import.meta.dir, '..', '..', '..');
  test('every entry is exactly the count the step refuses, and no counted file is missing', async () => {
    const counted = new Map<string, number>();
    for (const app of ['.', 'examples/dummy', 'dummy/social-media-clone', 'dummy/docs-site']) {
      for (const [file, count] of (await checkErrorFixReport(join(repo, app))).sequenceRefused) {
        counted.set(file, (counted.get(file) ?? 0) + count);
      }
    }
    expect(Object.fromEntries([...FIX_SEQUENCE_BASELINE].sort())).toEqual(
      Object.fromEntries([...counted].sort()),
    );
  }, 180_000);
});
