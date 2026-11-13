// The workflow is the one file in the scaffold nobody can run locally to find out it is broken:
// a typo in it is a repository whose CI never ran, reported as a green PR page with no checks on
// it. So every claim it makes is asserted against the OTHER emitted files rather than against a
// literal typed twice — the Bun pin against `package.json`'s own `engines.bun`, the commands
// against the scripts `bin/` actually ships.

import { describe, expect, test } from 'bun:test';
import { YAML } from 'bun';
import { VERIFY_SUBCOMMANDS } from '../../cmd-verify-spec';
import { DEFAULT_PLAN_PARTS, planMatrix, verifyPlan } from '../../verify-plan';
import { names } from '../naming';
import { docsFiles } from '../scaffold-docs';
import { repoFiles } from '../scaffold-repo';
import { TEST_COMPOSE_PATH } from '../scaffold-test-services';
import { CI_WORKFLOW_PATH, githubFiles, PLAN_COMMAND } from './ci.yml';

const app = names('ledger-demo');

/** An emitted file's text. `contents` is a union because `x new` also writes a PNG. */
const emitted = (
  files: readonly { path: string; contents: string | Uint8Array }[],
  path: string,
) => {
  const found = files.find((file) => file.path === path);
  if (found === undefined) return expect.unreachable(`x new writes no ${path}`);
  return typeof found.contents === 'string'
    ? found.contents
    : expect.unreachable(`${path} is bytes, not text`);
};

const workflow = (): string => emitted(githubFiles(app), CI_WORKFLOW_PATH);

interface Job {
  readonly if?: string;
  readonly 'timeout-minutes'?: number;
  readonly needs?: string | readonly string[];
  readonly outputs?: Readonly<Record<string, string>>;
  readonly strategy?: { readonly 'fail-fast'?: boolean; readonly matrix?: unknown };
  readonly steps?: readonly Step[];
}
interface Workflow {
  readonly on?: Readonly<Record<string, unknown>>;
  readonly jobs?: Readonly<Record<string, Job>>;
}
interface Step {
  readonly id?: string;
  readonly if?: string;
  readonly uses?: string;
  readonly run?: string;
  readonly with?: Readonly<Record<string, unknown>>;
  readonly env?: Readonly<Record<string, string>>;
}

const parsed = (): Workflow => YAML.parse(workflow()) as Workflow;

const job = (name: string): Job => parsed().jobs?.[name] ?? expect.unreachable(`no ${name} job`);

/** The gate part's steps: the job every runner of the matrix runs. */
const steps = (): readonly Step[] => job('gate').steps ?? [];

const runsOf = (name: string): readonly string[] =>
  (job(name).steps ?? []).flatMap((step) => (step.run === undefined ? [] : [step.run]));

describe('unit · the CI workflow x new writes', () => {
  // GitHub reads `.github/workflows/*.yml` and nothing else. A workflow one directory away is a
  // file with no reader and no error — the silent half of this whole feature.
  test('it lands where GitHub reads it, and x new is what writes it', () => {
    expect(CI_WORKFLOW_PATH).toBe('.github/workflows/ci.yml');
    expect(docsFiles(app).map((file) => file.path)).toContain(CI_WORKFLOW_PATH);
  });

  // Parsed, not matched: a workflow that is not YAML is accepted by every `toContain` in this file
  // and by no runner on GitHub.
  test('it is YAML: the plan, the gate in parts, the verdict — each a list of steps', () => {
    expect(Object.keys(parsed().jobs ?? {})).toEqual(['plan', 'gate', 'verify']);
    for (const name of ['plan', 'gate', 'verify']) {
      expect(job(name).steps?.length ?? 0).toBeGreaterThan(0);
    }
  });

  test('it triggers on push and on pull request, and on nothing else', () => {
    expect(Object.keys(parsed().on ?? {}).sort()).toEqual(['pull_request', 'push']);
  });

  // A `branches:` filter under `push` is silent when it is wrong: `x new` runs a plain `git init`
  // and takes whatever `init.defaultBranch` this machine agreed on, so `[main]` on a `master`
  // repository runs nothing at all and reports nothing. The generated `CLAUDE.md` promises a run
  // on every push, and a promise the workflow does not keep is worse than no promise.
  test('no branch filter — every push runs it, as the generated CLAUDE.md says', () => {
    // `null` is the whole assertion: ANY filter — `branches`, `branches-ignore`, `paths`, `tags` —
    // makes this a map. It rejects the narrowing without enumerating the ways to spell it.
    expect(parsed().on?.['push'] ?? null).toBeNull();
    expect(parsed().on?.['pull_request'] ?? null).toBeNull();
    // And in the text, ignoring comments — this file's own prose says why there is no filter, and
    // a `toContain` over the whole document would read that sentence as the thing it forbids.
    const code = workflow()
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'));
    expect(code.filter((line) => line.includes('branches'))).toEqual([]);
  });

  // The contract this file exists for: the app's OWN scripts, never a restatement of their steps.
  // A part runs `bun run setup`, starts what its level needs, and runs `bun run verify` on its
  // slice; the plan and the verdict are `bun run verify` too.
  test('every part runs bun run setup and then bun run verify on its slice, and restates neither', () => {
    const runs = runsOf('gate');
    expect(runs[0]).toBe('bun run setup');
    expect(runs.at(-1)).toContain(
      ['bun run verify --only "$ONLY" $', '{SHARD:+--shard "$SHARD"} --json'].join(''),
    );
    expect(runsOf('plan').at(-1)).toContain(PLAN_COMMAND);
    expect(runsOf('verify').at(-1)).toBe('bun run verify merge "$RUNNER_TEMP"/parts/*.json');
    for (const name of ['plan', 'verify']) expect(runsOf(name)).toContain('bun install');
  });

  // The stack those two steps start and read is one the scaffold actually writes — the order is
  // the test above's; this holds the paths to files that exist.
  test('the test stack it starts is the one the scaffold writes', () => {
    const written = new Set(repoFiles(app, '1.0.0', true).map((file) => file.path));
    expect(written.has('docker/docker-compose.test.yml')).toBe(true);
    expect(written.has('docker/test-services.env')).toBe(true);
  });

  // One gate, one name: `bun run verify` is `x verify`, whose budgets step builds when its stats
  // are missing or stale (plan 101, 21) — so no step builds first, and no `bun run check` exists.
  test('the gate it runs is bun run verify alone: no build step before it, no check script', () => {
    const runs = ['plan', 'gate', 'verify'].flatMap(runsOf);
    expect(runs.filter((run) => run.includes('x build') || run.includes('run check'))).toEqual([]);
  });

  // The defect the whole Bun-floor change exists for, in its CI shape: a runner older than the
  // floor installs fine and dies on the next line with X_BUN_VERSION. Read from the emitted
  // manifest rather than from the constant, so a `package.json` that drifts fails HERE.
  test('the Bun it installs is the floor the emitted package.json declares', () => {
    const manifest = JSON.parse(emitted(repoFiles(app, '1.0.0', true), 'package.json')) as {
      readonly engines?: { readonly bun?: string };
    };
    const declared = manifest.engines?.bun ?? '';
    expect(declared).toMatch(/^>=\d+\.\d+\.\d+$/);
    for (const name of ['plan', 'gate', 'verify']) {
      const pin = (job(name).steps ?? []).find((step) => step.uses?.startsWith('oven-sh/setup-bun'))
        ?.with?.['bun-version'];
      expect(pin).toBe(declared.replace('>=', ''));
    }
  });

  // `latest` and a bare major are how a runtime change arrives unannounced in every run at once.
  test('the pin is an exact patch — never latest, never a range', () => {
    const pin = steps().find((step) => step.uses?.startsWith('oven-sh/setup-bun'))?.with?.[
      'bun-version'
    ];
    expect(String(pin)).toMatch(/^\d+\.\d+\.\d+$/);
  });

  // This step runs before any of the app's code does. A movable tag there is somebody else's write
  // access to every CI run of every app scaffolded by this framework.
  test('the third-party action is pinned by commit SHA, with its version in the comment', () => {
    const line = workflow()
      .split('\n')
      .find((text) => text.includes('oven-sh/setup-bun'));
    expect(line).toMatch(/oven-sh\/setup-bun@[0-9a-f]{40} # v\d+\.\d+\.\d+$/);
  });

  // A hung step holds a runner for GitHub's six-hour default with no signal at all.
  test('every job is bounded in time', () => {
    for (const name of ['plan', 'gate', 'verify']) {
      expect(job(name)['timeout-minutes']).toBeGreaterThan(0);
    }
  });
});

// The matrix is `x verify plan`'s answer, never a list typed here: a step added to the gate lands
// in a part with no edit to this file. These hold the workflow to the plan it reads.
describe('unit · the CI workflow x new writes · the gate in parts', () => {
  test('the matrix is the plan job’s output, read by fromJSON, and a red part cancels none', () => {
    expect(job('gate').needs).toBe('plan');
    expect(job('gate').strategy?.matrix).toBe(expr('fromJSON(needs.plan.outputs.matrix)'));
    expect(job('gate').strategy?.['fail-fast']).toBe(false);
    expect(job('plan').outputs?.['matrix']).toBe(expr('steps.plan.outputs.matrix'));
    const plan = (job('plan').steps ?? []).find((step) => step.id === 'plan');
    expect(plan?.run).toBe(
      `echo "matrix=$(${PLAN_COMMAND} | jq -c '.data.matrix')" >> "$GITHUB_OUTPUT"`,
    );
    expect(PLAN_COMMAND).toBe(`bun run verify plan --parts ${String(DEFAULT_PLAN_PARTS)} --json`);
  });

  // `bun run verify plan` is `x verify plan`: a subcommand the CLI does not have is a plan job
  // that dies on X_CLI_UNKNOWN_COMMAND and a repository whose every run is red.
  test('every x verify subcommand the workflow runs is one the CLI has', () => {
    const subs = ['plan', 'gate', 'verify']
      .flatMap(runsOf)
      .flatMap((run) => [...run.matchAll(/bun run verify ([a-z]+)\b/g)].map((m) => m[1] ?? ''));
    expect(subs.length).toBeGreaterThan(0);
    for (const sub of subs) expect(VERIFY_SUBCOMMANDS as readonly string[]).toContain(sub);
  });

  test('the keys the part reads are the keys the plan emits, and every level is handled', () => {
    const rows = planMatrix(verifyPlan(DEFAULT_PLAN_PARTS)).include as Record<string, unknown>[];
    const emitted = new Set(rows.flatMap((row) => Object.keys(row)));
    const read = new Set([...workflow().matchAll(/matrix\.([a-z]+)/g)].map((m) => m[1] ?? ''));
    expect([...read].sort()).toEqual([...emitted].sort());
    const handled = steps().flatMap(
      (step) => /^matrix\.needs == '([a-z]+)'$/.exec(step.if ?? '')?.[1] ?? [],
    );
    // Every level any runner count can emit but `none`, which starts nothing.
    const levels = new Set(
      [1, DEFAULT_PLAN_PARTS]
        .flatMap((parts) => verifyPlan(parts).map((part) => part.needs))
        .filter((level) => level !== 'none'),
    );
    expect(handled.sort()).toEqual([...levels].sort());
  });

  test('a database part starts the compose file’s postgres and hands on its URL alone', () => {
    const compose = YAML.parse(emitted(repoFiles(app, '1.0.0', true), TEST_COMPOSE_PATH)) as {
      readonly services: Readonly<Record<string, unknown>>;
    };
    const database = steps().find((step) => step.if === "matrix.needs == 'database'")?.run ?? '';
    expect(Object.keys(compose.services)).toContain('postgres');
    expect(database).toContain(`docker compose -f ${TEST_COMPOSE_PATH} up -d --wait postgres`);
    expect(emitted(repoFiles(app, '1.0.0', true), 'docker/test-services.env')).toMatch(
      /^TEST_DATABASE_URL=/m,
    );
  });

  test('every part hands the verdict its document, red or green, under its own name', () => {
    const upload = steps().find((step) => step.uses?.startsWith('actions/upload-artifact@'));
    expect(upload?.with?.['name']).toBe(`verify-part-${expr('matrix.part')}`);
    expect(upload?.with?.['overwrite']).toBe(true);
    expect(String(steps().at(-1)?.if)).toBe(expr('!cancelled()'));
  });

  test('the verdict runs over a red part and merges every part the plan made', () => {
    expect(job('verify').needs).toEqual(['plan', 'gate']);
    expect(job('verify').if).toContain('!cancelled()');
    const download = (job('verify').steps ?? []).find((step) =>
      step.uses?.startsWith('actions/download-artifact@'),
    );
    expect(download?.with?.['pattern']).toBe('verify-part-*');
    expect(download?.with?.['merge-multiple']).toBe(true);
  });
});

interface Efficient {
  readonly concurrency?: { readonly group?: string; readonly 'cancel-in-progress'?: unknown };
  readonly jobs?: Readonly<Record<string, { readonly if?: string }>>;
}

describe('unit · the CI workflow pays for each commit once', () => {
  const doc = (): Efficient => YAML.parse(workflow()) as Efficient;

  // Cancelling is safe only off the default branch: there the group is the SHA, so two commits can
  // never share one and neither run can cancel the other.
  test('a superseded run is cancelled, and a default-branch commit keys its own group', () => {
    const concurrency = doc().concurrency;
    expect(concurrency?.['cancel-in-progress']).toBe(true);
    expect(concurrency?.group).toContain('github.event.repository.default_branch');
    expect(concurrency?.group).toContain('github.sha');
  });

  // Both halves: dropping the pull_request run for a same-repo branch is the saving, and a fork's
  // pull request — which fires no push in this repository — must still be gated.
  test('a same-repository pull request is skipped, and a fork pull request still runs', () => {
    const gate = doc().jobs?.['plan']?.if ?? '';
    expect(gate).toContain("github.event_name == 'push'");
    expect(gate).toContain('github.event.pull_request.head.repo.full_name != github.repository');
  });

  test('the install cache is keyed on the lockfile, restored before bun run setup installs', () => {
    const cache = steps().findIndex((step) => step.uses?.startsWith('actions/cache@'));
    const setup = steps().findIndex((step) => step.run === 'bun run setup');
    expect(cache).toBeGreaterThanOrEqual(0);
    expect(setup).toBeGreaterThan(cache);
    expect(String(steps()[cache]?.with?.['key'])).toContain("hashFiles('bun.lock')");
  });
});

/** `${{ body }}`, spelled so the source holds no `${` — a workflow expression is not a template. */
const expr = (body: string): string => ['$', '{{ ', body, ' }}'].join('');

interface Runs {
  readonly name?: string;
  readonly jobs?: Readonly<
    Record<
      string,
      {
        readonly 'runs-on'?: unknown;
        readonly defaults?: { readonly run?: { readonly shell?: string } };
      }
    >
  >;
}

describe('unit · the runner each emitted workflow asks for', () => {
  const jobsOf = (path: string) => (YAML.parse(emitted(githubFiles(app), path)) as Runs).jobs ?? {};

  // A free GitHub-hosted runner is the default — the owner's rule — and a repository variable is
  // the override, so moving the gate to a bigger or self-hosted runner is a setting, never an edit
  // to a file `x new` wrote and a later scaffold would diff against.
  test('the gate runs on vars.CI_RUNNER, falling back to the free ubuntu-latest', () => {
    for (const job of Object.values(jobsOf(CI_WORKFLOW_PATH))) {
      expect(job['runs-on']).toBe(expr("vars.CI_RUNNER || 'ubuntu-latest'"));
    }
  });

  // The image job's steps are bash and Docker. On a Windows label the default shell is pwsh and
  // `${SHA::7}` is a syntax error, so a green gate would publish nothing: it never follows the
  // variable, and it names its shell.
  test('the image job stays on ubuntu-latest, in bash, whatever CI_RUNNER says', () => {
    const jobs = Object.values(jobsOf('.github/workflows/image.yml'));
    expect(jobs.length).toBe(1);
    for (const job of jobs) {
      expect(job['runs-on']).toBe('ubuntu-latest');
      expect(job.defaults?.run?.shell).toBe('bash');
    }
  });
});

interface Published {
  readonly on?: {
    readonly workflow_run?: { readonly workflows?: readonly string[]; readonly types?: unknown };
  };
  readonly permissions?: Readonly<Record<string, string>>;
  readonly jobs?: Readonly<
    Record<
      string,
      {
        readonly if?: string;
        readonly 'timeout-minutes'?: number;
        readonly steps?: readonly Step[];
      }
    >
  >;
}

describe('unit · the image workflow x new writes', () => {
  const image = (): string => emitted(githubFiles(app), '.github/workflows/image.yml');
  const doc = (): Published => YAML.parse(image()) as Published;
  const runs = (): string =>
    (doc().jobs?.['publish']?.steps ?? []).flatMap((step) => step.run ?? []).join('\n');

  // Read off the OTHER file: renaming the gate workflow and not this trigger is an image that
  // never publishes again, silently.
  test('it waits for the gate workflow, by the name ci.yml declares, to complete', () => {
    const gate = (YAML.parse(workflow()) as Runs).name;
    expect(doc().on?.workflow_run?.workflows).toEqual([String(gate)]);
    expect(doc().on?.workflow_run?.types).toEqual(['completed']);
    expect(Object.keys(doc().on ?? {})).toEqual(['workflow_run']);
  });

  // Each clause is a way to publish an image no green gate judged: a red run, a fork's pull
  // request with the registry token in scope, a branch other than the default.
  test('it publishes only a green push to this repository’s default branch', () => {
    const gate = doc().jobs?.['publish']?.if ?? '';
    expect(gate).toContain("github.event.workflow_run.conclusion == 'success'");
    expect(gate).toContain("github.event.workflow_run.event == 'push'");
    expect(gate).toContain(
      'github.event.workflow_run.head_branch == github.event.repository.default_branch',
    );
    expect(gate).toContain(
      'github.event.workflow_run.head_repository.full_name == github.repository',
    );
  });

  test('it builds the commit the gate judged, from the Dockerfile x new writes', () => {
    const checkout = doc().jobs?.['publish']?.steps?.find((step) =>
      step.uses?.startsWith('actions/checkout@'),
    );
    expect(checkout?.with?.['ref']).toBe(expr('github.event.workflow_run.head_sha'));
    const dockerfiles = docsFiles(app)
      .map((file) => file.path)
      .filter((path) => path.endsWith('/Dockerfile'));
    expect(dockerfiles).toEqual(['docker/Dockerfile']);
    expect(runs()).toContain('docker build -f docker/Dockerfile ');
  });

  // GITHUB_TOKEN with `packages: write` is the whole credential: nothing for the owner to create,
  // and no other scope is granted.
  test('its one credential is the job token, scoped to packages', () => {
    expect(doc().permissions).toEqual({ contents: 'read', packages: 'write' });
    expect(image()).not.toContain('secrets.');
  });

  // `latest` is a pointer a late run for an older commit moves backwards; the SHA tags never move.
  test('it tags by commit and never latest', () => {
    // bash's own substring expansion of the commit, spelled so this source holds no `${`.
    expect(runs()).toContain(['sha-$', '{SHA::7}'].join(''));
    expect(image()).not.toMatch(/:latest\b/);
  });

  test('the job is bounded in time', () => {
    expect(doc().jobs?.['publish']?.['timeout-minutes']).toBeGreaterThan(0);
  });
});
