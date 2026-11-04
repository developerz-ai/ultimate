// The repo gate's own tests: the host checks this repo runs on itself, the rules they carry, and
// the seam that puts them on a step.
//
// THE CI FAILURE THIS FILE CARRIES (ci push run 41714452760, job `packages (1/2)`, step "tests +
// coverage per package"). That job runs `bun run scripts/coverage-gate.ts --all --shard 1/2`; the
// coverage unit list is the 30 tiered packages plus `create-ultimate` (it has a
// `packages/create-ultimate/src/`) plus `scripts` — 32 units, sorted — so `scripts` is index 26
// and lands in shard 1/2, whose suite is `bun test ./scripts`
// (scripts/lib/coverage-units.ts:22-29). This file ran THERE and failed with:
//
//   - []   + [{ "at": ".github/workflows/ci.yml", "code": "X_PRIVATE_NAMES_UNSET", "cause": "a
//               push to main ran with ULTIMATE_PRIVATE_NAMES empty, so the private-name guard
//               would scan nothing and pass; on main the secret must arrive" }]
//
// THE CAUSE, established and reproduced — NOT the tier rule and NOT the manifest. The four host
// checks that assertion calls in sequence (tierBoundaries, frameworkManifest, errorCodeDocs,
// checkRoadmap) shared ONE opaque `expect(...).toEqual([])`, so the test NAME could not say which
// one failed; only the diff could, and it named `X_PRIVATE_NAMES_UNSET` — the private-name
// guard's CONFIGURATION rule: the run that requires the names must carry them, or the guard
// scans nothing and passes. It fired because `scripts/verify.ts`'s `tierBoundaries` read
// `process.env` for it, so "does this tree have boundary violations" depended on WHICH PROCESS
// asked. The `packages` job IS a push to main on Actions and is handed NO secret — by design:
// ci.yml gives `ULTIMATE_PRIVATE_NAMES` to the `gate` part that runs `boundaries`, and to nobody
// else. REPRODUCED: with the secret unset and the guard's requirement DECLARED, the assertion
// fails with that diff.
//
// THE CAUSE TEXT ABOVE IS THE ONE THAT RUN PRINTED, and it names the guard of THAT tree: it
// inferred the requirement from the push event, so the tree scan carried it into every job on
// the push. The guard in this tree asks for the requirement EXPLICITLY — `scripts/private-names.ts`
// raises `X_PRIVATE_NAMES_UNSET` only when `ULTIMATE_PRIVATE_NAMES_REQUIRED` is `1` and the names
// are empty, and its header says the rule is "Never inferred from the event". So the cause it
// prints today is "`ULTIMATE_PRIVATE_NAMES_REQUIRED=1` and `ULTIMATE_PRIVATE_NAMES` is empty, so
// the private-name guard would scan nothing and pass; the step that requires the names must
// receive the secret". The CODE and the FILE in the diff above are the same; the wording is the
// guard's, and it moved with the rule.
//
// THE REPAIR. `tierBoundaries` is the TREE's answer and is now env-independent; the private-name
// guard is `privateNames` in `scripts/verify.ts`, a RUN's answer, and the gate's `boundaries`
// step runs both. The rule is NOT weakened: it still fires for the run that requires the names
// and arrives without them.
//
// THE SECOND ENV-READING RULE, found by the self-review of the repair above: the split was not
// complete. `tierBoundaries` still reached the environment TRANSITIVELY — its last rule,
// `stabilityFindings(root)`, falls back to `Bun.env` when it is handed no environment
// (`scripts/lib/stability-findings.ts`), and `targetBranch(env)` answers 'main' on a push to main
// and nothing on a pull request or a local run. So the no-break-on-main rule (`X_BREAKING_ON_MAIN`)
// — WHERE a change is landing — was still the tree scan's answer, and the tree scan's answer still
// varied by the process that asked. The repair completes the split: the tree half asks the
// stability rule with an EXPLICIT empty environment, and the rule that needs to know the branch
// is `breaksOnMain`, a RUN's answer beside `privateNames`, wired onto the same step. The rule is
// NOT weakened: it still fires for a break headed to `main` inside a closed window, and the tests
// below pin both halves — the tree scan never answers it, and the run's half still does.
//
// WHERE THE TWO HALVES' ASSERTIONS LIVE. The four host checks below each have their OWN named
// assertion, so a failure says WHICH scan failed and WHAT it found — that is the first repair, and
// it is in this file. The assertions that pin the split itself — the tree scan reads no
// environment, and neither run rule is answered by the tree scan — are one responsibility of their
// own and live in `scripts/verify-split.test.ts`, beside this file and in the same `scripts` unit
// (`bun test ./scripts`), so the `packages (1/2)` CI shard runs them.
import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises'; // why: Bun has no mkdtemp and no recursive remove.
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';
import { exec, readVerifyFloor, VERIFY_STEPS, verifyStepNames } from '@ultimat3/cli';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';
// `checkRoadmap`'s own cases are in `scripts/roadmap.test.ts`, next to their source.
import { checkRoadmap } from './roadmap';
import {
  ERROR_REFERENCE,
  errorCodeDocs,
  frameworkFiles,
  frameworkManifest,
  HOST_CHECKS,
  manifestFailureCause,
  mergeGateParts,
  tierBoundaries,
} from './verify';

describe('unit · a generation failure is described, never re-thrown', () => {
  // Two values `error instanceof Error ? error.message : String(error)` — what stood here — cannot
  // survive: a Proxy makes `instanceof` throw from its trap, and a null-prototype object makes
  // `String()` throw `No default value`. Either leaves `x verify` reporting an uncoded crash
  // instead of X_VERIFY_FAILED with a `bun run manifest` beside it.
  test('a null-prototype object is rendered rather than thrown from', () => {
    // `String(Object.create(null))` throws; this is the half a Symbol does NOT demonstrate, since
    // `String(aSymbol)` answers 'Symbol(nope)' and only `${aSymbol}` throws.
    expect(manifestFailureCause(Object.create(null))).toContain(
      'the framework manifest could not be generated',
    );
  });

  test('a thrown Symbol is rendered rather than thrown from', () => {
    expect(manifestFailureCause(Symbol('nope'))).toContain('Symbol(nope)');
  });

  test('a Proxy whose getPrototypeOf trap throws is rendered too', () => {
    const hostile = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new TypeError('no prototype for you');
        },
      },
    );
    expect(manifestFailureCause(hostile)).toContain(
      'the framework manifest could not be generated',
    );
  });

  test('an ordinary Error still contributes its message', () => {
    expect(manifestFailureCause(new Error('spawn failed'))).toContain('spawn failed');
  });
});

describe('unit · the repo gate refuses a Bun below the pin', () => {
  // `x` refuses one in `dispatch`; this script calls `runVerify` directly, so it must say so itself,
  // and BEFORE the gate: on Bun 1.4.0 the gate ran to the end and went red in a bundler defect.
  test('the runtime is checked before any step runs', async () => {
    const source = await Bun.file(join(repoRoot(), 'scripts/verify.ts')).text();
    const main = source.slice(source.indexOf('if (import.meta.main)'));
    const check = main.indexOf('requireBunVersion(Bun.version)');
    expect(check).toBeGreaterThan(0);
    expect(check).toBeLessThan(main.indexOf('runVerify('));
    expect(check).toBeLessThan(main.indexOf('mergeGateParts('));
  });
});

describe('unit · the repo gate is the CLI gate', () => {
  test('the repo adds rules to steps, never steps of its own', () => {
    const names: readonly string[] = verifyStepNames();
    for (const step of Object.keys(HOST_CHECKS)) expect(names).toContain(step);
    expect(Object.keys(HOST_CHECKS)).toEqual(['boundaries', 'errors', 'manifest', 'roadmap']);
  });

  // `errorCodeDocs` dynamically imports every @ultimat3/* package to build the registry — real
  // work regardless of how small `dir` is. `REPO_SCAN_TIMEOUT_MS` says why the budget moved.
  test(
    'the error reference is enforced through the errors step',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'ultimate-verify-docs-'));
      try {
        await Bun.write(
          join(dir, 'packages/core/src/errors.ts'),
          "export const CORE_ERROR_CODES = ['X_MADE_UP'] as const;\n",
        );
        await Bun.write(join(dir, ERROR_REFERENCE), '# Error codes\n');
        const findings = await errorCodeDocs(dir);
        expect(findings).toHaveLength(1);
        expect(findings[0]?.code).toBe('X_ERROR_CODE_UNDOCUMENTED');
        expect(findings[0]?.at).toBe(ERROR_REFERENCE);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    REPO_SCAN_TIMEOUT_MS,
  );

  test('a documented code no package registers fails the same step', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ultimate-verify-registry-'));
    try {
      await Bun.write(join(dir, ERROR_REFERENCE), '# Error codes\n\n| `X_GHOST` | means |\n');
      const findings = await errorCodeDocs(dir);
      expect(findings.map((finding) => finding.code)).toEqual(['X_ERROR_CODE_UNREGISTERED']);
      expect(findings[0]?.cause).toContain('X_GHOST');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  /**
   * `scripts/` never ships, so no package may own `X_ROADMAP_STATUS_MISSING` — and demanding a
   * registration for it would push a contributor-only code into every generated app. The host
   * scans its own scripts instead, and this is the assertion that the seam actually engages.
   */
  test('a code only this repo’s gate scripts declare needs no package registration', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ultimate-verify-host-codes-'));
    try {
      await Bun.write(
        join(dir, 'scripts/thing.ts'),
        "export const f = { code: 'X_HOST_ONLY', fix: 'bun run verify' };\n",
      );
      await Bun.write(join(dir, ERROR_REFERENCE), '# Error codes\n\n| `X_HOST_ONLY` | means |\n');
      expect(await errorCodeDocs(dir)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  /**
   * The seam, not the rules: `wiki-tables.test.ts` and `release-workflow.test.ts` own their own
   * cases. What is only provable here is that the `manifest` step actually carries them — a rule
   * with a test and no wiring is a rule `bun run verify` never runs.
   */
  test('a malformed wiki table is reported through the manifest step', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ultimate-verify-wiki-'));
    try {
      await Bun.write(join(dir, 'wiki/Bad.md'), '| a | b |\n|---|---|\n| 1 | 2 | 3 |\n');
      const codes = (await frameworkFiles(dir)).map((finding) => finding.code);
      expect(codes).toContain('X_WIKI_TABLE_MALFORMED');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('a workspace no release step publishes is reported through the manifest step', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ultimate-verify-publish-'));
    try {
      await Bun.write(
        join(dir, 'packages/core/package.json'),
        '{ "name": "@ultimat3/core", "version": "1.0.0" }\n',
      );
      await Bun.write(
        join(dir, '.github/workflows/release.yml'),
        '      - name: publish tier 0\n        run: npm publish -w @ultimat3/schema\n',
      );
      const codes = (await frameworkFiles(dir)).map((finding) => finding.code);
      expect(codes).toContain('X_PUBLISH_LIST_INCOMPLETE');
      expect(codes).toContain('X_PUBLISH_LIST_UNKNOWN');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('a chart left behind by a release is reported through the manifest step', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ultimate-verify-chart-'));
    try {
      await Bun.write(
        join(dir, 'packages/core/package.json'),
        '{ "name": "@ultimat3/core", "version": "1.3.0" }\n',
      );
      await Bun.write(join(dir, 'docker/helm/Chart.yaml'), 'version: 0.0.1\nappVersion: "0.0.1"\n');
      const codes = (await frameworkFiles(dir)).map((finding) => finding.code);
      expect(codes).toContain('X_CHART_VERSION_STALE');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  /**
   * The seam, not the rules: `scripts/test-discovery.test.ts` owns the rule's own cases. What is
   * only provable here is that the `manifest` step carries it — a rule with a test and no wiring
   * is a rule `bun run verify` never runs.
   */
  test('a test file the gate never discovers is reported through the manifest step', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ultimate-verify-discovery-'));
    try {
      await Bun.write(join(dir, 'a.spec.ts'), "test('seeded', () => {});\n");
      const codes = (await frameworkFiles(dir)).map((finding) => finding.code);
      expect(codes).toContain('X_TEST_DISCOVERY_UNSEEN');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  /**
   * The image contract rides `boundaries` rather than `manifest`: it is a convention this repo makes
   * about its own source, and it costs milliseconds, so it belongs before the suites.
   */
  test('an image that could not start is reported through the boundaries step', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ultimate-verify-image-'));
    try {
      // One source file: a root whose source scope reads nothing is refused (`X_CORPUS_UNSCANNED`)
      // before any rule runs, and this test is about the image rule.
      await Bun.write(join(dir, 'packages/core/src/ok.ts'), 'export const ok = 1;\n');
      await Bun.write(
        join(dir, 'docker/Dockerfile'),
        [
          'FROM oven/bun:1.3-alpine AS build',
          'RUN bun build --compile --outfile /out/app ./x.ts',
          'FROM gcr.io/distroless/cc-debian13:nonroot AS runtime',
          'COPY --from=build /out/app /app/x',
          'ENTRYPOINT ["/app/x"]',
          '',
        ].join('\n'),
      );
      const codes = (await tierBoundaries(dir)).map((finding) => finding.code);
      expect(codes).toContain('X_IMAGE_LIBC_MISMATCH');
      expect(codes).toContain('X_IMAGE_GUARD_MISSING');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('the tier table is enforced through the boundaries step', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ultimate-verify-host-'));
    try {
      await Bun.write(
        join(dir, 'packages/core/src/bad.ts'),
        "import { dispatch } from '@ultimat3/cli';\nexport const run = dispatch;\n",
      );
      // The tier rule's own findings: `tierBoundaries` carries other host rules on the same step
      // (the seal-call scan reports its exempt files missing from this one-file fixture).
      const findings = (await tierBoundaries(dir)).filter(
        (finding) => finding.code === 'X_BOUNDARY_VIOLATION',
      );
      expect(findings).toHaveLength(1);
      expect(findings[0]?.at).toBe('packages/core/src/bad.ts');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  /**
   * The floor is the ratchet on the ratchet: `applies` returning false records a step as SKIPPED
   * and green, so deleting a suite turns its step into a silent skip — unless `x.verify.json`
   * already claims this repo ran it. It listed 12 of the 14 applicable steps, and `job` and `eval`
   * were the two missing: deleting `packages/jobs/src/*.job.test.ts` would have left the gate at
   * "17/17 (1 skipped)" and exit 0.
   *
   * Asserted as a ratchet rather than as a fixed list, so a step that starts applying here has to
   * join the floor in the same commit.
   */
  test(
    'the committed floor names every step that applies in this repo',
    async () => {
      const root = repoRoot();
      const floor = await readVerifyFloor(root);
      expect(floor?.problems).toEqual([]);
      const ctx = { root, runner: exec, hostChecks: HOST_CHECKS };
      const missing: string[] = [];
      for (const step of VERIFY_STEPS) {
        // No `applies` means the step always runs, so it can never vanish and needs no floor line.
        if (step.applies === undefined) continue;
        if (!(await step.applies(ctx))) continue;
        if (floor?.steps.includes(step.name) !== true) missing.push(step.name);
      }
      expect(missing).toEqual([]);
    },
    REPO_SCAN_TIMEOUT_MS,
  );

  // Four full-repo scans, one a manifest regeneration over 29 packages — `REPO_SCAN_TIMEOUT_MS`.
  // FOUR assertions, one per host check, each naming its own.
  test.each([
    ['the boundaries scan finds no violation here', tierBoundaries],
    ['the manifest still generates and describes this tree', frameworkManifest],
    ['every error code this repo ships is documented', errorCodeDocs],
    ['the roadmap table describes what this repo ships', checkRoadmap],
  ] as const)(
    '%s',
    async (_name, check) => {
      const findings = await check(repoRoot());
      expect(findings.map((finding) => `${finding.code} at ${finding.at}`)).toEqual([]);
    },
    REPO_SCAN_TIMEOUT_MS,
  );
});

describe('unit · the repo gate says where it is, and where it hung', () => {
  test('a refused part names the command that runs at this root', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ultimate-verify-merge-'));
    try {
      const refusal = async (files: readonly string[]): Promise<{ code: string; fix: string }> => {
        try {
          await mergeGateParts(dir, files);
        } catch (error) {
          return error as { code: string; fix: string };
        }
        return expect.unreachable('the parts were accepted');
      };
      const gone = await refusal([join(dir, 'gone.json')]);
      expect(gone.code).toBe('X_VERIFY_MERGE_INPUT');
      expect(gone.fix.startsWith('bun run verify --only unit --json > part.json')).toBe(true);
      await Bun.write(join(dir, 'empty.json'), '');
      expect((await refusal([join(dir, 'empty.json')])).fix).not.toContain('x verify');
      // And a gap the merge finds is fixed by this entry's own merge.
      await Bun.write(
        join(dir, 'p.json'),
        JSON.stringify({ ok: true, command: 'verify', summary: 's', steps: [], data: {} }),
      );
      const merged = await mergeGateParts(dir, [join(dir, 'p.json')]);
      const fixes = merged.steps?.flatMap((step) => step.findings.map((finding) => finding.fix));
      expect(fixes?.length).toBeGreaterThan(0);
      for (const fix of fixes ?? []) expect(fix.startsWith('bun run verify merge ')).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test(
    '--json streams each finished step to stderr; stdout stays the one document',
    async () => {
      const proc = Bun.spawn(['bun', 'run', 'scripts/verify.ts', '--only', 'roadmap', '--json'], {
        cwd: repoRoot(),
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      await proc.exited;
      const lines = stderr.split('\n').filter((line) => line.startsWith('{'));
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0] ?? '')).toMatchObject({ step: 'roadmap' });
      const document = JSON.parse(stdout) as { steps: readonly { name: string }[] };
      expect(document.steps.map((step) => step.name)).toEqual(['roadmap']);
    },
    REPO_SCAN_TIMEOUT_MS,
  );
});
