import { describe, expect, test } from 'bun:test';
// why: Bun ships no `Bun.*` equivalent for either: `mkdtemp`/`rm` own a throwaway app root's
// lifetime, and `join` builds the host-separator paths the committed contract files are written to.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';
import { MANIFEST_FILENAME } from '@ultimat3/manifest';
import { OPENAPI_FILE } from './app-openapi';
import {
  readOnlyStep,
  runVerify,
  VERIFY_STEPS,
  verifyCommand,
  verifyStepNames,
} from './cmd-verify';
import { msg } from './messages';
import { exitCodeFor } from './output';
import { parseArgs } from './parse';
import { SPECS } from './registry';
import { thrownBy } from './thrown-by';
import { VERIFY_FLOOR_FILE } from './verify-floor';
import type { VerifyContext, VerifyStep } from './verify-step';
import { VERIFY_STEP_NAMES } from './verify-step';

/** The banner a narrowed run carries, from the catalog that renders it — never a second literal. */
const NOT_A_GATE_RUN = msg('cli.verify.notAGateRun', { summary: '' }).trim();

const ctx: VerifyContext = {
  root: '/nowhere',
  runner: async () => ({
    command: ['true'],
    code: 0,
    ok: true,
    stdout: '',
    stderr: '',
    durationMs: 0,
  }),
};

const stubs: readonly VerifyStep[] = [
  { name: 'typecheck', summary: 'tsc', run: async () => ({ ok: true, findings: [] }) },
  {
    name: 'drift',
    summary: 'schema vs migrations',
    run: async () => ({
      ok: false,
      findings: [
        {
          code: 'X_DB_DRIFT',
          cause: 'table "posts" has column "publish_at" not present in any migration',
          fix: 'x db gen "add publish_at"',
        },
      ],
    }),
  },
  {
    name: 'e2e',
    summary: 'playwright',
    applies: async () => false,
    run: async () => ({ ok: false, findings: [] }),
  },
];

describe('unit · x verify', () => {
  test('the step list covers every check in the contract', () => {
    expect(verifyStepNames()).toEqual([
      'typecheck',
      'lint',
      'boundaries',
      'filesize',
      'package-shape',
      'errors',
      'unit',
      'contract',
      'live',
      'job',
      'e2e',
      'eval',
      'drift',
      'contract-diff',
      'budgets',
      'seo',
      'i18n',
      'policy',
      'manifest',
      'roadmap',
    ]);
    expect(VERIFY_STEPS.every((step) => step.summary.length > 0)).toBe(true);
  });

  test('the declared names and the steps that exist are one list', () => {
    expect(verifyStepNames()).toEqual([...VERIFY_STEP_NAMES]);
  });

  test('a failing step makes the whole run fail and exit non-zero', async () => {
    const result = await runVerify(stubs, ctx);
    expect(result.ok).toBe(false);
    expect(exitCodeFor(result)).toBe(1);
    expect(result.steps?.map((step) => step.ok)).toEqual([true, false, true]);
  });

  test('every step reports its own duration and keeps its findings', async () => {
    const result = await runVerify(stubs, ctx);
    const drift = result.steps?.find((step) => step.name === 'drift');
    expect(drift?.durationMs).toBeGreaterThanOrEqual(0);
    expect(drift?.findings[0]?.fix).toBe('x db gen "add publish_at"');
  });

  test('a step that does not apply is skipped, not passed silently', async () => {
    const result = await runVerify(stubs, ctx);
    expect(result.steps?.find((step) => step.name === 'e2e')?.skipped).toBe(true);
  });

  // Counting the skips made them visible; nothing yet made one *fail*. A suite deleted in the same
  // pull request that deleted the code it covered turns a passing step into a skipped one and the
  // gate still exits 0 — so the floor is this repo's committed claim that the step ran here once,
  // and a step that stops applying against that claim is a failure, not a skip.
  describe('the ratchet: a step the committed floor requires may not go quiet', () => {
    const green: readonly VerifyStep[] = [
      { name: 'typecheck', summary: 'tsc', run: async () => ({ ok: true, findings: [] }) },
    ];
    const vanished: VerifyStep = {
      name: 'job',
      summary: 'no suite here',
      applies: async () => false,
      run: async () => ({ ok: false, findings: [] }),
    };

    const withFloor = async (
      floor: string | undefined,
      assert: (root: string) => Promise<void>,
    ): Promise<void> => {
      const root = await mkdtemp(join(tmpdir(), 'x-verify-ratchet-'));
      try {
        if (floor !== undefined) await Bun.write(join(root, VERIFY_FLOOR_FILE), floor);
        await assert(root);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    };

    test('no floor committed: a step with nothing to run is still an honest skip', async () => {
      await withFloor(undefined, async (root) => {
        const result = await runVerify([...green, vanished], { ...ctx, root });
        expect(result.ok).toBe(true);
        expect(result.data).toMatchObject({ failed: [], skipped: ['job'] });
      });
    });

    test('a floor that does not name the step leaves it a skip', async () => {
      await withFloor('{"steps":["typecheck"]}', async (root) => {
        const result = await runVerify([...green, vanished], { ...ctx, root });
        expect(result.ok).toBe(true);
        expect(result.data).toMatchObject({ skipped: ['job'] });
      });
    });

    test('a floor that names it turns the skip into a failed step with the fix', async () => {
      await withFloor('{"steps":["typecheck","job"]}', async (root) => {
        const result = await runVerify([...green, vanished], { ...ctx, root });
        expect(result.ok).toBe(false);
        expect(exitCodeFor(result)).toBe(1);
        const job = result.steps?.find((step) => step.name === 'job');
        expect(job?.findings[0]?.code).toBe('X_VERIFY_SUITE_VANISHED');
        expect(job?.findings[0]?.fix).toContain('x verify --json');
      });
    });

    // The whole value is that every reader of the run sees it: a step recorded as skipped would
    // stay out of `data.failed`, out of the failure count, and green in the reference-app gate's
    // own red list, which reads a step table exactly this shape.
    test('the vanished step is reported as failed and not as skipped, everywhere', async () => {
      await withFloor('{"steps":["job"]}', async (root) => {
        const result = await runVerify([...green, vanished], { ...ctx, root });
        expect(result.summary).toContain('1 of 2 steps failed');
        expect(result.summary).not.toContain('skipped');
        expect(result.data).toMatchObject({ failed: ['job'], skipped: [] });
        expect(result.steps?.find((step) => step.name === 'job')?.skipped).toBe(false);
      });
    });

    // The other way a suite vanishes: every file is still there and every test in them skips
    // itself. `applies` is `files.length > 0`, so the step runs, reports green, and the floor is
    // satisfied by a run that asserted nothing — measured on this repo as `live: 4 pass, 114 skip`
    // with no TEST_DATABASE_URL. Zero non-skipped tests is the same "nothing to check" the code
    // already names, so it is the same code and not a second one.
    const allSkipped: VerifyStep = {
      name: 'live',
      summary: 'every test skipped itself',
      run: async () => ({ ok: true, findings: [], tests: { ran: 0, skipped: 118 } }),
    };

    test('a floor step whose suite ran zero non-skipped tests is a failure, not a pass', async () => {
      await withFloor('{"steps":["typecheck","live"]}', async (root) => {
        const result = await runVerify([...green, allSkipped], { ...ctx, root });
        expect(result.ok).toBe(false);
        expect(result.data).toMatchObject({ failed: ['live'], skipped: [] });
        const live = result.steps?.find((step) => step.name === 'live');
        expect(live?.findings[0]?.code).toBe('X_VERIFY_SUITE_VANISHED');
        expect(live?.findings[0]?.cause).toContain('118');
        expect(live?.findings[0]?.fix).toContain('x test live');
      });
    });

    test('a floor step that ran even one non-skipped test is green', async () => {
      const thin: VerifyStep = {
        ...allSkipped,
        run: async () => ({ ok: true, findings: [], tests: { ran: 1, skipped: 117 } }),
      };
      await withFloor('{"steps":["typecheck","live"]}', async (root) => {
        const result = await runVerify([...green, thin], { ...ctx, root });
        expect(result.ok).toBe(true);
        expect(result.steps?.find((step) => step.name === 'live')?.findings).toEqual([]);
      });
    });

    // The floor is the claim; without one there is nothing to be measured against, and a repo that
    // never committed one is not ratcheted in either direction.
    test('with no floor, an all-skipped suite stays the honest pass it was', async () => {
      await withFloor(undefined, async (root) => {
        const result = await runVerify([...green, allSkipped], { ...ctx, root });
        expect(result.ok).toBe(true);
      });
    });

    test('a floor is silent about steps that do apply', async () => {
      await withFloor('{"steps":["typecheck"]}', async (root) => {
        const result = await runVerify(green, { ...ctx, root });
        expect(result.ok).toBe(true);
        expect(result.steps?.[0]?.findings).toEqual([]);
      });
    });

    // A name the gate does not run can never apply, so pinning it would hold the gate red forever
    // and dropping it silently would leave a floor covering nothing. The `manifest` step owns the
    // file's own integrity; the ratchet owns the suites.
    test('a typo in the floor is reported by the manifest step, not by the ratchet', async () => {
      await withFloor('{"steps":["contarct"]}', async (root) => {
        const result = await runVerify([...green, vanished], { ...ctx, root });
        expect(result.ok).toBe(true);
        const step = VERIFY_STEPS.find((candidate) => candidate.name === 'manifest');
        const outcome = await step?.run({ ...ctx, root });
        expect(outcome?.ok).toBe(false);
        const finding = outcome?.findings.find((each) => each.at === VERIFY_FLOOR_FILE);
        expect(finding?.code).toBe('X_CONFIG_INVALID');
        expect(finding?.cause).toContain('contarct');
      });
    });
  });

  test('it never bails early: later steps still run after a failure', async () => {
    const seen: string[] = [];
    const traced = stubs.map<VerifyStep>((step) => ({
      ...step,
      run: async (context) => {
        seen.push(step.name);
        return step.run(context);
      },
    }));
    await runVerify(traced, ctx);
    expect(seen).toEqual(['typecheck', 'drift']);
  });

  // `--workers` is a knob on how wide the test steps spread, never on which steps run. `--only`
  // IS a narrowing and is the one exception, decided as D6: it must announce itself in BOTH
  // renderers, which is what keeps "green" meaning the no-flag run. Any THIRD flag arriving here
  // — a `--skip`, above all — is the regression this test exists to catch.
  test('the no-flag run is every step, and the only narrowing announces itself', async () => {
    const result = await runVerify(stubs, ctx);
    expect(result.steps?.map((step) => step.name)).toEqual(['typecheck', 'drift', 'e2e']);
    expect(result.summary).not.toContain(NOT_A_GATE_RUN);
    expect(verifyCommand.spec.flags?.map((flag) => flag.name)).toEqual(['workers', 'only']);
    expect(verifyCommand.spec.usage).toBe('x verify [--only <step>] [--workers N] [--json]');
  });

  // The whole gate is ~18s, 14s of it `tsc -b`, so the loop this closes is "ask about one step".
  describe('--only names a step, and an unknown one is refused before anything runs', () => {
    const argsFor = (argv: readonly string[]) => parseArgs(argv, SPECS);

    test('every declared step name reads back as itself', () => {
      for (const name of VERIFY_STEP_NAMES) {
        expect([name, readOnlyStep(argsFor(['verify', '--only', name]))]).toEqual([name, name]);
      }
      expect(readOnlyStep(argsFor(['verify']))).toBeUndefined();
    });

    test('a near miss leads with the step it is near, and a runnable invocation', () => {
      const failure = thrownBy(() => readOnlyStep(argsFor(['verify', '--only', 'lnt'])));
      expect(failure.code).toBe('X_CLI_BAD_FLAG');
      expect(failure.cause).toContain('"lnt" is not a gate step');
      expect(failure.cause).toContain('typecheck, lint');
      expect(failure.fix).toBe('x verify --only lint --json');
    });

    // The house rule for a word near nothing: never an invented lead. The gate itself is the
    // honest fix, and it is a command that runs.
    test('a word near nothing gets the gate, not a guess', () => {
      expect(thrownBy(() => readOnlyStep(argsFor(['verify', '--only', 'zzzzzzzzzz']))).fix).toBe(
        'x verify --json',
      );
    });
  });

  test('a host check adds findings to the step it was registered for', async () => {
    const withHost: readonly VerifyStep[] = [
      {
        name: 'boundaries',
        summary: 'imports',
        run: async (context) => {
          const extra = (await context.hostChecks?.boundaries?.(context.root)) ?? [];
          return { ok: extra.length === 0, findings: extra };
        },
      },
    ];
    const result = await runVerify(withHost, {
      ...ctx,
      hostChecks: {
        boundaries: async () => [
          { code: 'X_BOUNDARY_VIOLATION', cause: 'cli imports admin', fix: 'invert the import' },
        ],
      },
    });
    expect(result.ok).toBe(false);
    expect(result.steps?.[0]?.findings[0]?.code).toBe('X_BOUNDARY_VIOLATION');
  });

  // A step that reports findings alone claims a completeness a parser-less scan does not have.
  // The coverage line rides in `output`, which `--json` carries verbatim and `--verbose` prints.
  test('the errors step reports what it read and what it could not', async () => {
    const step = VERIFY_STEPS.find((candidate) => candidate.name === 'errors');
    const root = await mkdtemp(join(tmpdir(), 'x-errors-'));
    try {
      await Bun.write(
        join(root, 'packages', 'db', 'src', 'errors.ts'),
        "export const raise = (cause: string, fix: string) => new E({ code: 'X_A', cause, fix });\n" +
          "raise('one', 'x db migrate --json');\nraise('two', computed);\n",
      );
      const outcome = await step?.run({ ...ctx, root });
      expect(outcome?.ok).toBe(true);
      expect(outcome?.output).toBe('checked 1 fix line(s), could not read 1');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // `openapi.json` is a published contract on its own — the typed client is generated from it —
  // so gating the step on `x.manifest.json` let a stale spec ship a wrong client unchecked.
  describe('contract-diff applies to either committed contract', () => {
    const step = VERIFY_STEPS.find((candidate) => candidate.name === 'contract-diff');

    const withRoot = async (
      files: Readonly<Record<string, string>>,
      assert: (root: string) => Promise<void>,
    ): Promise<void> => {
      const root = await mkdtemp(join(tmpdir(), 'x-contract-diff-'));
      try {
        for (const [name, body] of Object.entries(files)) await Bun.write(join(root, name), body);
        await assert(root);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    };

    test('neither file committed: the step is skipped, as before', async () => {
      await withRoot({}, async (root) => {
        expect(await step?.applies?.({ ...ctx, root })).toBe(false);
      });
    });

    test('openapi.json alone is enough to run it', async () => {
      await withRoot({ [OPENAPI_FILE]: '{}' }, async (root) => {
        expect(await step?.applies?.({ ...ctx, root })).toBe(true);
      });
    });

    test('x.manifest.json alone is still enough to run it', async () => {
      await withRoot({ [MANIFEST_FILENAME]: '{}' }, async (root) => {
        expect(await step?.applies?.({ ...ctx, root })).toBe(true);
      });
    });

    test('an openapi.json that no longer matches the code fails with no manifest present', async () => {
      const files = {
        [OPENAPI_FILE]: '{"openapi":"3.1.0"}',
        'package.json': JSON.stringify({ name: 'spec-only', version: '1.0.0' }),
      };
      await withRoot(files, async (root) => {
        const outcome = await step?.run({ ...ctx, root });
        expect(outcome?.ok).toBe(false);
        expect(outcome?.findings.map((finding) => finding.at)).toContain(OPENAPI_FILE);
        expect(outcome?.findings[0]?.fix).toBe('x manifest');
      });
    });
  });

  // The step loads the app to read its declared budgets, and threw the load's own findings away.
  // A module that will not import registers no route, so its budgets are missing from the manifest
  // and every one of them came back `X_BUDGET_UNMEASURED` — "run x build" for a file that does not
  // compile. The cause has to travel with the symptom or the reader is sent to the wrong place.
  describe('budgets reports what loading the app said', () => {
    const step = VERIFY_STEPS.find((candidate) => candidate.name === 'budgets');

    test('a module that will not import is a finding on this step', async () => {
      const root = await mkdtemp(join(tmpdir(), 'x-budgets-'));
      try {
        await Bun.write(
          join(root, 'package.json'),
          JSON.stringify({ name: 'broken-app', version: '1.0.0' }),
        );
        await Bun.write(join(root, 'app.config.ts'), 'export const config = {};\n');
        await Bun.write(
          join(root, 'apps/web/app/broken/module.ts'),
          "throw new Error('this module never imports');\n",
        );
        expect(await step?.applies?.({ ...ctx, root })).toBe(true);
        const outcome = await step?.run({ ...ctx, root });
        const broken = outcome?.findings.filter(
          (finding) => finding.at === 'apps/web/app/broken/module.ts',
        );
        expect(broken?.[0]?.cause).toContain('this module never imports');
        expect(outcome?.ok).toBe(false);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  });

  describe('roadmap applies to a repo that HAS a roadmap', () => {
    const step = VERIFY_STEPS.find((candidate) => candidate.name === 'roadmap');

    test('skipped in a repo with no docs/idea/14-roadmap.md', async () => {
      expect(await step?.applies?.(ctx)).toBe(false);
    });

    // The bug this guards: `applies` keyed on a CALLER-supplied option, so a caller of the exported
    // `runVerify(VERIFY_STEPS, ctx)` that passes no `hostChecks` — in a repo whose committed
    // `x.verify.json` names `roadmap` — got `X_VERIFY_SUITE_VANISHED`, whose `fix:` is the command
    // that just failed. Whether the step applies is a fact about the repo, never about the call.
    test('applies on the file, not on the option', async () => {
      const root = await mkdtemp(join(tmpdir(), 'x-verify-roadmap-'));
      try {
        await Bun.write(join(root, 'docs', 'idea', '14-roadmap.md'), '# roadmap\n');
        expect(await step?.applies?.({ ...ctx, root })).toBe(true);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    test('applies and surfaces the host findings once one is registered', async () => {
      // `cmd-verify` carries `fix` through to both renderers verbatim, so the fixture holds a real
      // one: an exact edit naming the file, the row and the marker, not advice.
      const finding = {
        code: 'X_ROADMAP_STATUS_MISSING',
        cause: 'milestone 3 has no status marker',
        fix: 'edit docs/idea/14-roadmap.md: put "✅" or "🚧" in the second cell of the row starting "| 3 |", then: bun run scripts/roadmap.ts --json',
      };
      const withHost: VerifyContext = { ...ctx, hostChecks: { roadmap: async () => [finding] } };
      const outcome = await step?.run(withHost);
      expect(outcome?.ok).toBe(false);
      expect(outcome?.findings).toEqual([finding]);
    });
  });

  test('a step that throws becomes a finding, not a crash', async () => {
    const boom: VerifyStep[] = [
      {
        name: 'boundaries',
        summary: 'imports',
        run: async () => {
          // Deliberately a bare Error, and the only shape that tests this: the subject is a step
          // that fails with something the framework never coded — a transpiler, a driver, an OOM.
          // Coding it here would assert that `runVerify` re-reports codes, which is a different
          // claim than "an unstructured throw still lands as X_VERIFY_FAILED with a fix".
          throw new Error('transpiler exploded');
        },
      },
    ];
    const result = await runVerify(boom, ctx);
    expect(result.ok).toBe(false);
    expect(result.steps?.[0]?.findings[0]?.code).toBe('X_VERIFY_FAILED');
    expect(result.steps?.[0]?.findings[0]?.fix).toBe('x verify --json');
  });
});
