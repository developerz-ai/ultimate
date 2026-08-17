import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exec, readVerifyFloor, VERIFY_STEPS, verifyStepNames } from '@ultimat3/cli';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';
// Only the integration assertion below lives here — `checkRoadmap`'s own cases are in
// `scripts/roadmap.test.ts`, next to their source.
import { checkRoadmap } from './roadmap';
import {
  ERROR_REFERENCE,
  errorCodeDocs,
  frameworkFiles,
  frameworkManifest,
  HOST_CHECKS,
  tierBoundaries,
} from './verify';

const readJson = async (path: string): Promise<unknown> => Bun.file(path).json();

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** One key off a parsed tsconfig, checked rather than cast — the file is data, not a type. */
const field = (value: unknown, key: string): unknown => (isRecord(value) ? value[key] : undefined);

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
   * The image contract rides `boundaries` rather than `manifest`: it is a convention this repo makes
   * about its own source, and it costs milliseconds, so it belongs before the suites.
   */
  test('an image that could not start is reported through the boundaries step', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ultimate-verify-image-'));
    try {
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
      const findings = await tierBoundaries(dir);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.code).toBe('X_BOUNDARY_VIOLATION');
      expect(findings[0]?.at).toBe('packages/core/src/bad.ts');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // Bun's runtime reads the tsconfig at the CWD to transpile JSX, and at the repo root that is
  // this file — a solution-style config that carries no compilerOptions of its own unless it is
  // told to. Without these two keys every `.tsx` in the repo transpiles against the React
  // automatic runtime, which is not installed, so `bun test` at the root cannot import a single
  // component. One JSX flavour, declared where the runtime looks for it.
  test('the root tsconfig tells the runtime which JSX runtime this repo uses', async () => {
    const options = field(await readJson(join(repoRoot(), 'tsconfig.json')), 'compilerOptions');
    expect(field(options, 'jsx')).toBe('preserve');
    expect(field(options, 'jsxImportSource')).toBe('solid-js');
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

  /**
   * `tsc -b` compiles the projects the root REFERENCES and nothing else, and a project can only be
   * referenced if it is `composite`. `scripts/` satisfied neither: `scripts/tsconfig.json` set
   * `composite: false` and no `references` entry named it, so `export const probe: number = 'no'`
   * dropped anywhere under `scripts/` left `bunx tsc -b` at exit 0 — the gate's own implementation
   * compiled nowhere, which is how `list-workspaces.ts` shipped passing a string to a number
   * parameter. Both halves are asserted, because either one alone puts the hole straight back.
   */
  test('the root build graph contains scripts/, and scripts/ can be referenced', async () => {
    const root = repoRoot();
    const references = field(await readJson(join(root, 'tsconfig.json')), 'references');
    const paths = (Array.isArray(references) ? references : []).map((ref) => field(ref, 'path'));
    expect(paths).toContain('./scripts');
    const options = field(await readJson(join(root, 'scripts/tsconfig.json')), 'compilerOptions');
    expect(field(options, 'composite')).toBe(true);
  });

  /**
   * What the two keys above BUY, proved against a real `tsc -b` rather than asserted about it: a
   * type error in a referenced composite project fails the build, and the same error in the same
   * project fails nothing once the reference is gone. Run on a two-file solution in a temp dir —
   * the repo's own build is minutes and writes `.tsbuildinfo` every other suite shares.
   */
  test(
    'tsc -b fails on a referenced project and passes over an unreferenced one',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'ultimate-verify-refs-'));
      try {
        const project = {
          compilerOptions: { composite: true, noEmit: true, strict: true, types: [] },
        };
        for (const name of ['sub', 'other']) {
          await Bun.write(join(dir, name, 'tsconfig.json'), JSON.stringify(project));
        }
        await Bun.write(join(dir, 'other/ok.ts'), 'export const ok = 1;\n');
        await Bun.write(
          join(dir, 'sub/probe.ts'),
          "export const probe: number = 'not a number';\n",
        );
        const tsc = join(repoRoot(), 'node_modules/.bin/tsc');
        // `other` is always referenced, so the solution has something to build either way and the
        // exit code is answering "was sub compiled?" and not "was this configuration empty?".
        const build = async (paths: readonly string[]): Promise<number> => {
          const references = paths.map((path) => ({ path }));
          await Bun.write(join(dir, 'tsconfig.json'), JSON.stringify({ files: [], references }));
          await rm(join(dir, 'sub/tsconfig.tsbuildinfo'), { force: true });
          return (await exec([tsc, '-b', '--pretty', 'false'], { cwd: dir })).code;
        };
        expect(await build(['./other', './sub'])).not.toBe(0);
        expect(await build(['./other'])).toBe(0);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    REPO_SCAN_TIMEOUT_MS,
  );

  // Four full-repo scans, one of them a complete manifest regeneration over 29 packages —
  // `REPO_SCAN_TIMEOUT_MS`.
  test(
    'this repo has no tier violations and its manifest still generates',
    async () => {
      const root = repoRoot();
      expect(await tierBoundaries(root)).toEqual([]);
      expect(await frameworkManifest(root)).toEqual([]);
      expect(await errorCodeDocs(root)).toEqual([]);
      expect(await checkRoadmap(root)).toEqual([]);
    },
    REPO_SCAN_TIMEOUT_MS,
  );
});
