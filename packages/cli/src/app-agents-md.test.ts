// The AGENTS.md half of the `manifest` step. Two codes were documented and registered long
// before anything called the check that raises them, so these tests exist to prove the gate
// actually engages — a check nothing invokes reads exactly like a check that always passes.

import { describe, expect, test } from 'bun:test';
// Bun ships no `Bun.*` equivalent: `mkdtemp`/`rm` own a throwaway repo root's lifetime, and
// `join` builds the host-separator paths the check reads.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AGENTS_MD_FILENAME, AGENTS_MD_MAX_BYTES } from '@ultimat3/manifest';
import { checkAgentsMd } from './app-agents-md';
import { VERIFY_STEPS } from './cmd-verify';
import { exec } from './exec';
import { scaffoldVariants } from './scaffold-fixture';

const withRoot = async (run: (root: string) => Promise<void>): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), 'x-agents-md-'));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');

describe('the AGENTS.md gate', () => {
  test('a repo with no AGENTS.md fails, and the fix says to write one by hand', async () => {
    await withRoot(async (root) => {
      const { findings } = await checkAgentsMd(root);
      expect(findings.map((finding) => finding.code)).toEqual(['X_AGENTS_MD_MISSING']);
      expect(findings[0]?.at).toBe(AGENTS_MD_FILENAME);
      // Never "run the generator": there deliberately is none, so the fix has to name the act.
      expect(findings[0]?.fix).toContain('by hand');
    });
  });

  test('a file over the byte budget fails with the size in the cause', async () => {
    await withRoot(async (root) => {
      const oversized = 'x'.repeat(AGENTS_MD_MAX_BYTES + 1);
      await Bun.write(join(root, AGENTS_MD_FILENAME), oversized);
      const { findings } = await checkAgentsMd(root);
      expect(findings.map((finding) => finding.code)).toEqual(['X_AGENTS_MD_TOO_LARGE']);
      expect(findings[0]?.cause).toContain(String(AGENTS_MD_MAX_BYTES + 1));
    });
  });

  test('a short hand-written file passes with nothing to say', async () => {
    await withRoot(async (root) => {
      await Bun.write(join(root, AGENTS_MD_FILENAME), '# AGENTS.md\n\nBun only. Run x verify.\n');
      expect(await checkAgentsMd(root)).toEqual({ findings: [], warnings: [] });
    });
  });

  test('a file that tabulates generated facts warns without failing', async () => {
    await withRoot(async (root) => {
      const tabulated = '# AGENTS.md\n\n| route | mode |\n|---|---|\n| /feed | ssr |\n';
      await Bun.write(join(root, AGENTS_MD_FILENAME), tabulated);
      const { findings, warnings } = await checkAgentsMd(root);
      // A warning is a judgement call, not a build error: the step still goes green.
      expect(findings).toEqual([]);
      expect(warnings.join(' ')).toContain('x.manifest.json');
    });
  });
});

describe('the manifest step runs it', () => {
  const manifestStep = VERIFY_STEPS.find((step) => step.name === 'manifest');

  test('the step never reports as skipped: AGENTS.md is always answerable', () => {
    // The drift half needs a committed manifest to compare against; this half needs nothing.
    // `applies` returning false would take both down with it and read as green.
    expect(manifestStep?.applies).toBeUndefined();
  });

  test('a missing AGENTS.md fails the step even with no manifest to diff', async () => {
    await withRoot(async (root) => {
      const outcome = await manifestStep?.run({ root, runner: exec });
      expect(outcome?.ok).toBe(false);
      expect(outcome?.findings.map((finding) => finding.code)).toEqual(['X_AGENTS_MD_MISSING']);
    });
  });

  test('warnings ride in the step output so --json carries them', async () => {
    await withRoot(async (root) => {
      const tabulated = '# AGENTS.md\n\n| entity | column |\n|---|---|\n| post | id |\n';
      await Bun.write(join(root, AGENTS_MD_FILENAME), tabulated);
      const outcome = await manifestStep?.run({ root, runner: exec });
      expect(outcome?.ok).toBe(true);
      expect(outcome?.output).toContain(AGENTS_MD_FILENAME);
    });
  });

  test("this repo's own AGENTS.md satisfies the gate it now ships", async () => {
    expect(await checkAgentsMd(REPO_ROOT)).toMatchObject({ findings: [] });
  });

  // `x new`'s output has to pass `x verify` unmodified. Dropping AGENTS.md from the templates
  // would fail the gate in every generated app, and only here does that surface as one failure
  // rather than as a mystery in someone else's repo.
  test.each(scaffoldVariants())('$name scaffolds an AGENTS.md that passes', async (variant) => {
    const agents = variant.files.find((file) => file.path === AGENTS_MD_FILENAME);
    expect(agents).toBeDefined();
    await withRoot(async (root) => {
      await Bun.write(join(root, AGENTS_MD_FILENAME), agents?.contents ?? '');
      expect(await checkAgentsMd(root)).toMatchObject({ findings: [] });
    });
  });
});
