// The gate-part documents the `verify` CI job merges. `scripts/verify-parts.ts` WAS the only row of
// `docs/architecture/guards.md` with no suite of its own, and it could not have one that imported
// it: the whole body sits inside `if (import.meta.main)`, the module exports nothing, and it ends
// in `report()` — which prints and calls `process.exit`. Every branch was therefore reachable only
// from the script's own entry point, and a refusal that lost its finding, an `at` that stopped
// naming the document, or a merge list that started carrying an earlier attempt's red document
// would stay green in the tree.
//
// So this file drives the REAL entry point as a child process, the way `scripts/tag-on-origin.test.ts`
// does: `bun run scripts/verify-parts.ts <dir> --json` with the repository root as the working
// directory. What is proved is the CONTRACT the `verify` job depends on — the `data` array the CI
// job hands `x verify merge`, and the `X_VERIFY_PART_UNNAMED` refusal that stops a re-run from
// merging a document it cannot order.
//
// The parsing rule itself is NOT proved here: `scripts/lib/ci-attempt-parts.ts` owns the
// `<part>.attempt-<n>` rule and has its own suite beside it. What was missing was coverage of the
// SCRIPT — the refusal shapes, the `at` each one names, and the exit code — and that is what the
// four cases below hold.

import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
// why: Bun ships no mkdtemp and no recursive remove.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.write and import() take one already joined.
import { join } from 'node:path';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';

// Spawns a real process per case, so the budget is the repo-scan backstop rather than Bun's
// 5000ms default — see `REPO_SCAN_TIMEOUT_MS`.
setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

/** Every temp directory this file made, removed after the case that made it. */
const madeDirs: string[] = [];
afterEach(async () => {
  for (const dir of madeDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

interface Finding {
  readonly code: string;
  readonly cause: string;
  readonly fix: string;
  readonly at?: string;
}

interface Verdict {
  readonly ok: boolean;
  readonly script: string;
  readonly summary: string;
  readonly findings: readonly Finding[];
  readonly data?: readonly string[];
}

/**
 * Drive the real entry point under `--json`, so the whole reply is one parseable envelope.
 *
 * `--json` is LAST because `parseScriptArgs` swallows whatever follows it as the flag's value
 * (`--json /tmp/parts` becomes `--json=/tmp/parts`, exactly the trap the parser refutes). That
 * would be a test-only artifact rather than the input the script under test sees.
 */
const ran = async (argv: readonly string[]): Promise<{ code: number; verdict: Verdict }> => {
  const proc = Bun.spawn(['bun', 'run', 'scripts/verify-parts.ts', ...argv, '--json'], {
    cwd: repoRoot(),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return { code, verdict: JSON.parse(out.trim()) as Verdict };
};

/** A throwaway directory holding the given part documents, by file name. */
const partsDir = async (files: readonly string[]): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'ultimate-verify-parts-'));
  madeDirs.push(dir);
  for (const name of files) await Bun.write(join(dir, name), '{}\n');
  return dir;
};

describe('unit · verify-parts · the refusals', () => {
  test('a document naming no attempt is refused, and the finding names the document', async () => {
    // `unit-1.json` names no run attempt, so it cannot be told from another attempt's copy of
    // the same part. Merging it would merge the red document a re-run replaced — the defect this
    // guard exists for.
    const dir = await partsDir(['unit-1.json']);
    const { code, verdict } = await ran([dir]);
    expect(code).toBe(1);
    expect(verdict.ok).toBe(false);
    expect(verdict.findings).toHaveLength(1);
    const finding = verdict.findings[0];
    expect(finding?.code).toBe('X_VERIFY_PART_UNNAMED');
    // The finding names the DOCUMENT, not the directory: the directory holds many documents and
    // the one that cannot be ordered is the one an agent has to rename.
    expect(finding?.at).toBe(join(dir, 'unit-1.json'));
    // An unnamed document is never merged.
    expect(verdict.data).toEqual([]);
  });

  test('an empty directory is refused, and the finding names the directory', async () => {
    // No part document at all is a different fact from a document that names no attempt: here the
    // download pattern and the upload name disagree, and the directory is what an agent has to
    // look at.
    const dir = await partsDir([]);
    const { code, verdict } = await ran([dir]);
    expect(code).toBe(1);
    expect(verdict.ok).toBe(false);
    expect(verdict.findings).toHaveLength(1);
    const finding = verdict.findings[0];
    expect(finding?.code).toBe('X_VERIFY_PART_UNNAMED');
    expect(finding?.at).toBe(dir);
    expect(verdict.data).toEqual([]);
  });

  test('no directory at all is refused with X_CLI_BAD_FLAG', async () => {
    // The script reads a directory; without one it has nothing to read, and the refusal says so
    // rather than globbing the working directory.
    const { code, verdict } = await ran([]);
    expect(code).toBe(1);
    expect(verdict.ok).toBe(false);
    expect(verdict.findings).toHaveLength(1);
    expect(verdict.findings[0]?.code).toBe('X_CLI_BAD_FLAG');
    // The refusal carries no `at`: there is no file to point at.
    expect(verdict.findings[0]?.at).toBeUndefined();
  });
});

describe('unit · verify-parts · what the merge is handed', () => {
  test("a part's newest attempt is the only one merged, and the earlier one is reported superseded", async () => {
    // The "re-run failed jobs" case: the download holds BOTH attempts, and merging the older one
    // would fold the red document the rerun replaced back into the verdict.
    const dir = await partsDir(['unit-1.attempt-1.json', 'unit-1.attempt-2.json']);
    const { code, verdict } = await ran([dir]);
    expect(code).toBe(0);
    expect(verdict.ok).toBe(true);
    expect(verdict.findings).toEqual([]);
    // ONLY the newest attempt is in `data` — the array the CI job hands `x verify merge`.
    expect(verdict.data).toEqual([join(dir, 'unit-1.attempt-2.json')]);
    // And the summary counts the one that was left out, so the log says what was dropped.
    expect(verdict.summary).toContain('1 part document(s) to merge');
    expect(verdict.summary).toContain('1 superseded by a re-run');
  });
});
