// What the guard seam has to refuse, before what it has to accept. Every case here is a way an
// app-supplied check could have passed silently — no export, a throw, a finding that is not one,
// a `fix:` that is advice — because a guard that fails open is worse than no guard at all: the
// app believes its convention is enforced.

import { describe, expect, test } from 'bun:test';
// Bun ships no equivalent for any of these: `mkdtemp`/`rm` own a throwaway app root's lifetime,
// `join` builds the host-separator path a guard file is written at.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VERIFY_STEPS } from './cmd-verify';
import { exec } from './exec';
import { GUARD_DIR, guardFindings, guardPaths } from './guards';
import { guardFiles } from './templates';

/** A throwaway app root holding exactly the guard files a case needs. */
const withGuards = async (
  files: Readonly<Record<string, string>>,
  body: (root: string) => Promise<void>,
): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), 'x-guards-'));
  try {
    for (const [name, contents] of Object.entries(files)) {
      await Bun.write(join(root, GUARD_DIR, name), contents);
    }
    await body(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

const codes = (findings: readonly { code: string }[]): readonly string[] =>
  findings.map((finding) => finding.code);

describe('unit · a guard that cannot be trusted is a finding, never a silent pass', () => {
  test('a file in guards/ that exports no guard is refused', async () => {
    await withGuards({ 'no-export.ts': 'export const rule = 1;\n' }, async (root) => {
      const findings = await guardFindings(root);
      expect(codes(findings)).toEqual(['X_GUARD_INVALID']);
      expect(findings[0]?.at).toBe('guards/no-export.ts');
    });
  });

  test('a guard missing check() is refused, exactly as one missing the export is', async () => {
    await withGuards(
      { 'half.ts': "export const guard = { summary: 'a rule' };\n" },
      async (root) => {
        expect(codes(await guardFindings(root))).toEqual(['X_GUARD_INVALID']);
      },
    );
  });

  test('a guard that throws is reported, and does not take the gate down with it', async () => {
    const source = `export const guard = {
  summary: 'a rule',
  check() {
    throw new Error('boom');
  },
};
`;
    await withGuards({ 'throws.ts': source }, async (root) => {
      const findings = await guardFindings(root);
      expect(codes(findings)).toEqual(['X_GUARD_FAILED']);
      expect(findings[0]?.cause).toContain('boom');
    });
  });

  test('a module that will not import is reported, not thrown', async () => {
    await withGuards({ 'broken.ts': 'export const guard = {' }, async (root) => {
      expect(codes(await guardFindings(root))).toEqual(['X_GUARD_FAILED']);
    });
  });

  test("a guard's finding is held to the same fix rule shipped source obeys", async () => {
    const source = `export const guard = {
  summary: 'a rule',
  check: () => [{ code: 'X_APP_RULE', cause: 'a thing is wrong', fix: 'check the config' }],
};
`;
    await withGuards({ 'advice.ts': source }, async (root) => {
      const findings = await guardFindings(root);
      expect(codes(findings)).toEqual(['X_GUARD_FINDING_INVALID']);
      // The rule that refused it is `fixProblem`'s, so the cause quotes the offending line.
      expect(findings[0]?.cause).toContain('check the config');
    });
  });

  test('a finding with no X_ code is refused: nothing could explain it', async () => {
    const source = `export const guard = {
  summary: 'a rule',
  check: () => [{ code: 'rule-broken', cause: 'a thing is wrong', fix: 'x verify' }],
};
`;
    await withGuards({ 'nocode.ts': source }, async (root) => {
      expect(codes(await guardFindings(root))).toEqual(['X_GUARD_FINDING_INVALID']);
    });
  });

  test('a guard that returns something other than a list of findings is refused', async () => {
    const source = `export const guard = { summary: 'a rule', check: () => 'ok' };\n`;
    await withGuards({ 'wrong.ts': source }, async (root) => {
      expect(codes(await guardFindings(root))).toEqual(['X_GUARD_FINDING_INVALID']);
    });
  });
});

describe('unit · a guard the app can trust reaches the gate verbatim', () => {
  const passing = `export const guard = {
  summary: 'a rule this app enforces',
  check: () => [
    { code: 'X_APP_RULE', cause: 'apps/web/app/a.ts breaks the rule', fix: 'x g action a' },
  ],
};
`;

  test('its findings arrive with their own code, cause and fix', async () => {
    await withGuards({ 'rule.ts': passing }, async (root) => {
      const findings = await guardFindings(root);
      expect(findings).toEqual([
        {
          code: 'X_APP_RULE',
          cause: 'apps/web/app/a.ts breaks the rule',
          fix: 'x g action a',
          at: 'guards/rule.ts',
        },
      ]);
    });
  });

  test('a finding that names its own `at` keeps it — the guard knows the subject, not the seam', async () => {
    const source = `export const guard = {
  summary: 'a rule',
  check: () => [
    { code: 'X_APP_RULE', cause: 'a thing', fix: 'x verify', at: 'apps/web/app/a.ts' },
  ],
};
`;
    await withGuards({ 'located.ts': source }, async (root) => {
      expect((await guardFindings(root))[0]?.at).toBe('apps/web/app/a.ts');
    });
  });

  test('an app with no guards/ has nothing to run and no finding to report', async () => {
    const root = await mkdtemp(join(tmpdir(), 'x-guards-'));
    try {
      expect(await guardPaths(root)).toEqual([]);
      expect(await guardFindings(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('a guard’s own test file is not a guard', async () => {
    await withGuards({ 'rule.ts': passing, 'rule.test.ts': "import './rule';\n" }, async (root) => {
      expect(await guardPaths(root)).toEqual(['guards/rule.ts']);
    });
  });

  test('the boundaries step runs them — a guard nothing runs is documentation', async () => {
    await withGuards({ 'rule.ts': passing }, async (root) => {
      const step = VERIFY_STEPS.find((candidate) => candidate.name === 'boundaries');
      const outcome = await step?.run({ root, runner: exec });
      expect(outcome?.ok).toBe(false);
      expect(codes(outcome?.findings ?? [])).toEqual(['X_APP_RULE']);
    });
  });
});

describe('unit · what x g guard writes is a guard the seam can actually run', () => {
  test('the scaffolded guard loads, runs, and passes on an app with no migrations', async () => {
    const files = guardFiles('migration-safety');
    const written = Object.fromEntries(
      files.map((file) => [file.path.slice(`${GUARD_DIR}/`.length), file.contents]),
    );
    await withGuards(written, async (root) => {
      expect(await guardPaths(root)).toEqual(['guards/migration-safety.ts']);
      expect(await guardFindings(root)).toEqual([]);
    });
  });

  test('and it catches the migration that passes every local gate', async () => {
    const files = guardFiles('migration-safety');
    const written = Object.fromEntries(
      files.map((file) => [file.path.slice(`${GUARD_DIR}/`.length), file.contents]),
    );
    await withGuards(written, async (root) => {
      await Bun.write(
        join(root, 'packages/db/migrations/0002_add_slug.sql'),
        'ALTER TABLE posts ADD COLUMN slug text NOT NULL;\n',
      );
      const findings = await guardFindings(root);
      expect(codes(findings)).toEqual(['X_MIGRATION_SAFETY']);
      expect(findings[0]?.at).toBe('packages/db/migrations/0002_add_slug.sql');
    });
  });
});
