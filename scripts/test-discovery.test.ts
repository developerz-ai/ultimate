// The enforcement half of `scripts/test-discovery.ts` — this file IS the build error: a shape the
// gate's discovery cannot yield must fail here, before it passes review as a test no step runs.
// Fixture roots are seeded under mkdtemp and removed in `finally`; the real tree is asserted clean,
// and the command itself is spawned so the script's own report is pinned too.

import { describe, expect, setDefaultTimeout, test } from 'bun:test';
// why: temp-dir fixtures are made and removed with node:fs; Bun ships no equivalent.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
// why: the OS's temp root is node:os's to name.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive, and the fixtures are host paths.
import { dirname, join } from 'node:path';
import { REPO_SCAN_TIMEOUT_MS, repoRoot, run } from './lib/run';
import {
  checkDiscovery,
  scanTree,
  testDiscoveryFindings,
  unseenByDiscovery,
} from './test-discovery';

// Every test here scans the real tree or seeds a fixture, so the file carries the repo-scan
// backstop at module scope — the form `scripts/repo-scan-timeout.test.ts` holds scanners to.
setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

/** Seed `files` (repo-relative POSIX keys) under a fresh temp root, run, then always remove it. */
async function seeded(
  files: Readonly<Record<string, string>>,
  run: (root: string) => void | Promise<void>,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'test-discovery-'));
  try {
    for (const [path, body] of Object.entries(files)) {
      const target = join(root, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, body);
    }
    await run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('unit · the discovery guard refuses a test file the gate cannot yield', () => {
  const positives: readonly (readonly [seed: string, at: string])[] = [
    ['a.spec.ts', 'a.spec.ts'],
    ['b_spec.ts', 'b_spec.ts'],
    ['c.test.js', 'c.test.js'],
    ['d.test.jsx', 'd.test.jsx'],
    ['__tests__/e.test.ts', '__tests__/e.test.ts'],
  ];

  for (const [seed, at] of positives) {
    test(`one ${seed} is exactly one finding naming it`, async () => {
      await seeded({ [seed]: "test('seeded', () => {});\n" }, async (root) => {
        const scan = scanTree(root);
        expect(scan.files).toBe(1);
        expect(scan.hits).toEqual([at]);
        const findings = checkDiscovery(scan);
        expect(findings).toHaveLength(1);
        const finding = findings[0] ?? expect.unreachable('one seeded shape, one finding');
        expect(finding.code).toBe('X_TEST_DISCOVERY_UNSEEN');
        expect(finding.at).toBe(at);
        expect(finding.fix.startsWith('git mv ')).toBe(true);
      });
    });
  }

  test('the fix renames each shape into the one convention', async () => {
    const renames: readonly (readonly [seed: string, target: string])[] = [
      ['a.spec.ts', 'a.test.ts'],
      ['b_spec.ts', 'b.test.ts'],
      ['c.test.js', 'c.test.ts'],
      ['d.test.jsx', 'd.test.tsx'],
      ['src/__tests__/e.test.ts', 'src/e.test.ts'],
    ];
    for (const [seed, target] of renames) {
      await seeded({ [seed]: '' }, async (root) => {
        const findings = checkDiscovery(scanTree(root));
        const finding = findings[0] ?? expect.unreachable('the seeded shape yields one');
        expect(finding.fix.endsWith(` ${target}`)).toBe(true);
        expect(unseenByDiscovery(target)).toBe(false);
      });
    }
  });

  test('discovered shapes yield none, and the SKIP list hides the seeded spec names', async () => {
    await seeded(
      {
        'a.test.ts': '',
        'plain.ts': '',
        'node_modules/a.spec.ts': '',
        'dist/b_spec.ts': '',
      },
      (root) => {
        const scan = scanTree(root);
        expect(scan.files).toBe(2);
        expect(scan.hits).toEqual([]);
        expect(checkDiscovery(scan)).toEqual([]);
      },
    );
  });

  test('a walk that read nothing is a blind walk, never a clean tree', async () => {
    await seeded({}, (root) => {
      const scan = scanTree(root);
      expect(scan.files).toBe(0);
      expect(scan.hits).toEqual([]);
      const findings = checkDiscovery(scan);
      expect(findings).toHaveLength(1);
      const finding = findings[0] ?? expect.unreachable('a blind walk yields one finding');
      expect(finding.code).toBe('X_TEST_DISCOVERY_UNSCANNED');
      expect(finding.at).toBe('scripts/test-discovery.ts');
      expect(finding.fix).toContain('scripts/test-discovery.ts');
      expect(findings.map((one) => one.code)).not.toContain('X_TEST_DISCOVERY_UNSEEN');
    });
  });

  test('the per-path predicate answers by shape', () => {
    expect(unseenByDiscovery('a.spec.ts')).toBe(true);
    expect(unseenByDiscovery('deep/nested/b_spec.ts')).toBe(true);
    expect(unseenByDiscovery('c.test.js')).toBe(true);
    expect(unseenByDiscovery('d.test.jsx')).toBe(true);
    expect(unseenByDiscovery('src/__tests__/e.test.ts')).toBe(true);
    expect(unseenByDiscovery('a.test.ts')).toBe(false);
    expect(unseenByDiscovery('a.test.tsx')).toBe(false);
    expect(unseenByDiscovery('plain.ts')).toBe(false);
    expect(unseenByDiscovery('specs/notes.md')).toBe(false);
  });

  test('the manifest rider answers findings for any root', async () => {
    await seeded({ 'foo.spec.ts': '' }, async (root) => {
      const findings = await testDiscoveryFindings(root);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.code).toBe('X_TEST_DISCOVERY_UNSEEN');
      expect(findings[0]?.at).toBe('foo.spec.ts');
    });
    await seeded({ 'kept.test.ts': '' }, async (root) => {
      expect(await testDiscoveryFindings(root)).toEqual([]);
    });
  });

  test('the real tree scans wide and holds no refused shape', () => {
    const scan = scanTree(repoRoot());
    expect(scan.files).toBeGreaterThan(1000);
    expect(checkDiscovery(scan)).toEqual([]);
  });

  test('the command itself reports the walk it read, and refuses nothing', async () => {
    const ran = await run(['bun', 'run', 'scripts/test-discovery.ts', '--json'], {
      cwd: repoRoot(),
    });
    expect(ran.code, ran.output).toBe(0);
    const line = ran.output.split('\n').find((one) => one.trimStart().startsWith('{'));
    if (line === undefined) return expect.unreachable('the command printed no JSON document');
    const answer = JSON.parse(line) as {
      ok: boolean;
      script: string;
      summary: string;
      findings: readonly { code: string }[];
      data: { files: number; hits: readonly string[] };
    };
    expect(answer.ok).toBe(true);
    expect(answer.script).toBe('test-discovery');
    expect(answer.findings).toEqual([]);
    expect(answer.data.files).toBeGreaterThan(0);
    expect(answer.data.hits).toEqual([]);
    expect(answer.summary).toContain(String(answer.data.files));
  });
});
