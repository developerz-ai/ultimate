// What the guard seam has to refuse, before what it has to accept. Every case here is a way an
// app-supplied check could have passed silently — no export, a throw, a finding that is not one,
// a `fix:` that is advice — because a guard that fails open is worse than no guard at all: the
// app believes its convention is enforced.

import { describe, expect, test } from 'bun:test';
// why: Bun ships no equivalent for any of these: `mkdtemp`/`rm` own a throwaway app root's
// lifetime, `join` builds the host-separator path a guard file is written at.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
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

/**
 * The file's text. `GeneratedSourceFile.contents` admits raw bytes — `x new` emits a PNG icon —
 * but `x g guard` writes TypeScript, so bytes reaching the app root written below are the failure.
 */
const textOf = (file: { readonly path: string; readonly contents: string | Uint8Array }): string =>
  typeof file.contents === 'string'
    ? file.contents
    : expect.unreachable(`${file.path} is bytes, not text`);

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

  // The validator is the thing that turns a guard's output into a structured failure. If IT is
  // what crashes, the gate hands an app author a stack trace out of framework internals for a bug
  // in their own guard — the one outcome this whole seam exists to prevent.
  test('a value the validator cannot even print is a finding, not a crash', async () => {
    const source = `export const guard = { summary: 'a rule', check: () => [1n] };\n`;
    await withGuards({ 'bigint.ts': source }, async (root) => {
      expect(codes(await guardFindings(root))).toEqual(['X_GUARD_FINDING_INVALID']);
    });
  });

  test('a field the validator cannot serialize is a finding, not a crash', async () => {
    const source = `export const guard = {
  summary: 'a rule',
  check: () => [{ code: 1n, cause: 'a thing is wrong', fix: 'x verify' }],
};
`;
    await withGuards({ 'bigint-code.ts': source }, async (root) => {
      expect(codes(await guardFindings(root))).toEqual(['X_GUARD_FINDING_INVALID']);
    });
  });

  test('a field that throws on read is a finding, not a crash', async () => {
    const source = `export const guard = {
  summary: 'a rule',
  check: () => [
    {
      get code() {
        throw new Error('hostile getter');
      },
      cause: 'a thing is wrong',
      fix: 'x verify',
    },
  ],
};
`;
    await withGuards({ 'hostile.ts': source }, async (root) => {
      const findings = await guardFindings(root);
      expect(codes(findings)).toEqual(['X_GUARD_FINDING_INVALID']);
      expect(findings[0]?.cause).toContain('hostile getter');
    });
  });

  test('one unreadable finding does not cost the readable ones beside it', async () => {
    const source = `export const guard = {
  summary: 'a rule',
  check: () => [1n, { code: 'X_APP_RULE', cause: 'a real one', fix: 'x verify' }],
};
`;
    await withGuards({ 'mixed.ts': source }, async (root) => {
      expect(codes(await guardFindings(root))).toEqual(['X_GUARD_FINDING_INVALID', 'X_APP_RULE']);
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
      files.map((file) => [file.path.slice(`${GUARD_DIR}/`.length), textOf(file)]),
    );
    await withGuards(written, async (root) => {
      expect(await guardPaths(root)).toEqual(['guards/migration-safety.ts']);
      expect(await guardFindings(root)).toEqual([]);
    });
  });

  test('and it catches the migration that passes every local gate', async () => {
    const files = guardFiles('migration-safety');
    const written = Object.fromEntries(
      files.map((file) => [file.path.slice(`${GUARD_DIR}/`.length), textOf(file)]),
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

  // The emitted rule is the worked example every app starts from, so the two inputs it has to get
  // right are exercised through the real seam, not asserted against the template's own text.
  test('a commented-out statement is not one, and DEFAULT NULL is not a default', async () => {
    const files = guardFiles('migration-safety');
    const written = Object.fromEntries(
      files.map((file) => [file.path.slice(`${GUARD_DIR}/`.length), textOf(file)]),
    );
    await withGuards(written, async (root) => {
      const migration = async (name: string, sql: string): Promise<void> => {
        await Bun.write(join(root, `packages/db/migrations/${name}`), sql);
      };
      await migration('0002_commented.sql', '/* ALTER TABLE posts ADD COLUMN a text NOT NULL; */');
      await migration(
        '0003_null.sql',
        'ALTER TABLE posts ADD COLUMN b text NOT NULL DEFAULT NULL;',
      );
      await migration('0004_safe.sql', "ALTER TABLE posts ADD COLUMN c text NOT NULL DEFAULT '';");
      const findings = await guardFindings(root);
      expect(codes(findings)).toEqual(['X_MIGRATION_SAFETY']);
      expect(findings[0]?.at).toBe('packages/db/migrations/0003_null.sql');
    });
  });
});
