// `x deploy` emits a plan, and the plan's ORDER is the contract: `migrate` gates the release,
// `backfill` trails every serving role. A backfill inside the release gate holds the deploy open
// while a slow UPDATE runs against a database still serving the previous build, which is the one
// arrangement this file exists to keep out.

import { describe, expect, test } from 'bun:test';
// why: Bun has no mkdtemp, and Bun.write is async in these synchronous fixture helpers.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';
import { isUltimateError } from '@ultimat3/core';
import {
  DEPLOY_METHODS,
  DEPLOY_ROLES,
  deployCommand,
  helmImageOverrides,
  planDeploy,
  readMethod,
} from './cmd-deploy';
import { planNewApp } from './cmd-new';
import type { CommandContext } from './command';
import { parseArgs } from './parse';
import { SPECS } from './registry';

const compose = (root = '/app') => planDeploy('repo/app:tag', 'compose', root);

describe('unit · the deploy plan', () => {
  test('migrate is first and backfill is LAST — deploy triggers, deploy never gates', () => {
    expect(DEPLOY_ROLES[0]).toBe('migrate');
    expect(DEPLOY_ROLES.at(-1)).toBe('backfill');
    // The whole order, as a literal — never `[...DEPLOY_ROLES]`, which is the plan's own input and
    // would stay green for a role deleted from the constant. A pairwise `indexOf` comparison cannot
    // stand alone here either: a plan missing `web` answers -1, which is below `backfill`'s real
    // index, so "backfill runs last" held for a deploy that never started the web role.
    const roles = compose().steps.map((step) => step.role);
    expect(roles).toEqual(['migrate', 'web', 'sync', 'worker', 'scheduler', 'backfill']);
  });

  test('the two run-once roles take `run --rm`, and every serving role takes `up -d`', () => {
    for (const step of compose().steps) {
      const oneShot = step.role === 'migrate' || step.role === 'backfill';
      expect(step.command).toContain(oneShot ? 'run' : 'up');
      expect(step.command).toContain(oneShot ? '--rm' : '-d');
      expect(step.command.at(-1)).toBe(step.role);
    }
  });

  test('every step names the app own compose file, and the image it was asked for', () => {
    const plan = compose('/srv/app');
    expect(plan.image).toBe('repo/app:tag');
    for (const step of plan.steps) {
      expect(step.command).toContain('/srv/app/docker/docker-compose.prod.yml');
    }
  });

  test('helm is one upgrade, so the ordering above is the chart to declare, not a step list', () => {
    const plan = planDeploy('repo/app:tag', 'helm', '/app');
    expect(plan.steps.map((step) => step.role)).toEqual(['all']);
  });

  // `docker/helm/values.yaml` declares `image` as a map and `_helpers.tpl` reads
  // `.Values.image.repository`. `--set image=<ref>` overwrote the map with a string, so the
  // command that was supposed to ship a new image rendered no workload at all.
  describe('the helm override sets the keys the chart reads', () => {
    test('a tagged reference sets repository and tag separately', () => {
      expect(helmImageOverrides('ghcr.io/org/app:1.2.3')).toEqual([
        '--set',
        'image.repository=ghcr.io/org/app',
        '--set',
        'image.tag=1.2.3',
      ]);
      expect(planDeploy('ghcr.io/org/app:1.2.3', 'helm', '/app').steps[0]?.command).not.toContain(
        'image=ghcr.io/org/app:1.2.3',
      );
    });

    // The chart's own `default .Chart.AppVersion` is the answer when no tag was asked for, and
    // setting `image.tag=` empty would not have reached it.
    test('a reference with no tag leaves the tag to the chart', () => {
      expect(helmImageOverrides('ghcr.io/org/app')).toEqual([
        '--set',
        'image.repository=ghcr.io/org/app',
      ]);
    });

    // A registry port is a colon before the last slash, and reading it as a tag would deploy
    // repository `localhost` at tag `5000/app`.
    test('a registry port is not a tag', () => {
      expect(helmImageOverrides('localhost:5000/app')).toEqual([
        '--set',
        'image.repository=localhost:5000/app',
      ]);
      expect(helmImageOverrides('localhost:5000/app:1.2.3')).toEqual([
        '--set',
        'image.repository=localhost:5000/app',
        '--set',
        'image.tag=1.2.3',
      ]);
    });

    test('a digest is refused with the tagged invocation to run instead', () => {
      expect(() => planDeploy('ghcr.io/org/app@sha256:abc123', 'helm', '/app')).toThrow(
        /pins a digest/,
      );
    });
  });

  test('the command declares every flag its own usage line names', () => {
    const flags = deployCommand.spec.flags?.map((flag) => flag.name) ?? [];
    for (const flag of ['image', 'method', 'dry-run']) expect(flags).toContain(flag);
    // `--critical` is gone, and its absence is the assertion: it parsed, it was echoed into the
    // plan JSON, and no file read that field — a flag whose only effect was on its own report.
    expect(flags).not.toContain('critical');
  });
});

/** An app root, because `x deploy` resolves one before it reads a single flag. */
function appRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'x-deploy-'));
  writeFileSync(join(dir, 'app.config.ts'), 'export const config = {};\n');
  return dir;
}

const contextFor = (argv: readonly string[], cwd: string): CommandContext => ({
  args: parseArgs(argv, SPECS),
  cwd,
  // A refused `--method` must never reach a subprocess, and a `--dry-run` never does either: a
  // call here is the failure, not a fixture.
  runner: (command) => {
    throw new Error(`x deploy spawned ${command.join(' ')}`);
  },
  env: {},
  bunVersion: '1.3.0',
});

// `flagString(...) === 'helm' ? 'helm' : 'compose'` made every OTHER spelling a Compose deploy that
// reported `ok: true, method: "compose"` — the operator asked for a Helm upgrade, got the six-step
// Compose plan, and the report agreed with what ran rather than with what was asked.
describe('unit · x deploy --method is a closed set', () => {
  test('an unknown method is refused, never silently run as compose', async () => {
    const root = appRoot();
    for (const raw of ['helmm', 'Helm', 'kubectl', 'COMPOSE']) {
      const thrown: unknown = await deployCommand
        .run(
          contextFor(['deploy', '--image', 'repo/app:1.2.3', '--method', raw, '--dry-run'], root),
        )
        .then(
          (result) => result,
          (error: unknown) => error,
        );
      expect([raw, (thrown as { code?: string }).code]).toEqual([raw, 'X_CLI_UNKNOWN_COMMAND']);
      expect([raw, (thrown as { cause: string }).cause]).toEqual([
        raw,
        `"x deploy --method ${raw}" is not a command (known: compose, helm)`,
      ]);
      expect([raw, (thrown as { fix: string }).fix]).toEqual([raw, 'x deploy --method compose']);
    }
  });

  test('both declared methods still resolve, and the absent flag is compose', () => {
    expect(DEPLOY_METHODS).toEqual(['compose', 'helm']);
    expect(readMethod(undefined)).toBe('compose');
    for (const method of DEPLOY_METHODS) expect(readMethod(method)).toBe(method);
  });

  test('a compose dry run reports the method it actually planned', async () => {
    const result = await deployCommand.run(
      contextFor(['deploy', '--image', 'repo/app:1.2.3', '--dry-run'], appRoot()),
    );
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ method: 'compose' });
  });
});

/** A runner that records, and answers with the exit code the test asked for. */
function recordingRunner(failing?: { role: string; code: number }): {
  runner: CommandContext['runner'];
  ran: string[][];
  envs: (Readonly<Record<string, string>> | undefined)[];
} {
  const ran: string[][] = [];
  const envs: (Readonly<Record<string, string>> | undefined)[] = [];
  const runner: CommandContext['runner'] = async (command, options) => {
    ran.push([...command]);
    envs.push(options.env);
    const code = failing !== undefined && command.at(-1) === failing.role ? failing.code : 0;
    return { command, code, ok: code === 0, stdout: '', stderr: '', durationMs: 3 };
  };
  return { runner, ran, envs };
}

const runContext = (
  argv: readonly string[],
  cwd: string,
  runner: CommandContext['runner'],
): CommandContext => ({ args: parseArgs(argv, SPECS), cwd, runner, env: {}, bunVersion: '1.3.0' });

describe('unit · x deploy actually runs the plan it printed', () => {
  test('every step is spawned, in plan order, in the app root', async () => {
    const root = appRoot();
    const { runner, ran } = recordingRunner();
    const result = await deployCommand.run(
      runContext(['deploy', '--image', 'repo/app:1.2.3'], root, runner),
    );
    expect(result.ok).toBe(true);
    expect(ran.map((command) => command.at(-1))).toEqual([...DEPLOY_ROLES]);
    // The plan in `--json` is the plan that ran: same commands, joined.
    const data = result.data as { steps: readonly { role: string; command: string }[] };
    expect(data.steps.map((step) => step.command)).toEqual(ran.map((command) => command.join(' ')));
  });

  test('a step that exits non-zero stops the deploy and names the command to rerun', async () => {
    const root = appRoot();
    const { runner, ran } = recordingRunner({ role: 'worker', code: 137 });
    const result = await deployCommand.run(
      runContext(['deploy', '--image', 'repo/app:1.2.3'], root, runner),
    );
    expect(result.ok).toBe(false);
    const finding = result.findings?.[0];
    expect(finding?.code).toBe('X_DEPLOY_FAILED');
    expect(finding?.cause).toBe('role "worker" step exited 137');
    // The fix is the exact argv that failed, with the environment it ran WITH — copy, paste, see
    // the output. Without the `IMAGE=` prefix the rerun reads `docker-compose.prod.yml`'s default
    // image, so the line handed back would diagnose a different deployment than the one that broke.
    expect(finding?.fix).toBe(
      `IMAGE=repo/app:1.2.3 ${(ran.at(-1) ?? []).join(' ')}   # run it directly to see the full output`,
    );
    // and nothing after `worker` was attempted.
    expect(ran.at(-1)?.at(-1)).toBe('worker');
    expect(ran).toHaveLength(DEPLOY_ROLES.indexOf('worker') + 1);
  });

  test('the plan carries no field nothing reads — `critical` is not in it', async () => {
    const root = appRoot();
    const { runner } = recordingRunner();
    const plan = await deployCommand.run(
      runContext(['deploy', '--image', 'repo/app:1.2.3'], root, runner),
    );

    expect(plan.data).toMatchObject({ image: 'repo/app:1.2.3', method: 'compose' });
    // `toMatchObject` cannot see an extra key, so the absence is asserted directly: this field was
    // the flag's only destination, and an operator reading it back was reading their own input.
    // `env` is the counter-example the rule allows — every step below is spawned with it.
    expect(Object.keys(plan.data as Record<string, unknown>)).toEqual([
      'image',
      'method',
      'env',
      'steps',
    ]);
  });

  test('--critical is refused now, and the refusal names the flags that exist', async () => {
    const root = appRoot();
    const { runner } = recordingRunner();
    let code = 'no-throw';
    try {
      await deployCommand.run(
        runContext(['deploy', '--image', 'repo/app:1.2.3', '--critical'], root, runner),
      );
    } catch (error) {
      code = isUltimateError(error) ? error.code : 'not-ultimate';
    }
    expect(code).toBe('X_CLI_BAD_FLAG');
  });
});

// The chart is scaffolded (`templates/scaffold-helm.ts`), so `x deploy --method helm` runs the
// build's own complete helm branch. It used to refuse first, with X_NOT_IMPLEMENTED — "helm deploy
// is not implemented in this build" over a build that implements it — and a fix line, "copy
// docker/helm from the framework repo", naming a repository an installed app never had and a
// directory that ships in no npm tarball.
describe('unit · x deploy --method helm runs the chart the scaffold writes', () => {
  test('x new writes docker/helm, so the plan names a path the app actually has', () => {
    const written = planNewApp({ name: 'demo-app', example: true }).map((file) => file.path);
    expect(written).toContain('docker/helm/Chart.yaml');
    // The exact path `planDeploy` hands to helm — one string, two files, no drift.
    const [, , , , chart] = planDeploy('repo/app:tag', 'helm', '/srv/app').steps[0]?.command ?? [];
    expect(chart).toBe(join('/srv/app', 'docker', 'helm'));
  });

  test('the upgrade is spawned, and no missing-file branch refuses it first', async () => {
    const root = appRoot();
    mkdirSync(join(root, 'docker', 'helm'), { recursive: true });
    const { runner, ran } = recordingRunner();
    const result = await deployCommand.run(
      runContext(['deploy', '--image', 'ghcr.io/org/app:1.2.3', '--method', 'helm'], root, runner),
    );
    expect(result.ok).toBe(true);
    expect(ran).toEqual([
      [
        'helm',
        'upgrade',
        '--install',
        'app',
        join(root, 'docker', 'helm'),
        '--set',
        'image.repository=ghcr.io/org/app',
        '--set',
        'image.tag=1.2.3',
      ],
    ]);
  });

  // An app that deleted its chart gets helm's own diagnosis through X_DEPLOY_FAILED, whose fix is
  // the command to rerun — never a claim that the feature does not exist.
  test('an app with no chart still runs helm, and reports what helm said', async () => {
    // Helm's own exit code, not a pre-flight guess: the one process that can say whether a chart
    // renders is helm, and `x deploy` hands its verdict back with the argv that produced it.
    const ran: string[][] = [];
    const runner: CommandContext['runner'] = async (command) => {
      ran.push([...command]);
      return { command, code: 1, ok: false, stdout: '', stderr: 'Error: no chart', durationMs: 3 };
    };
    const result = await deployCommand.run(
      runContext(['deploy', '--image', 'repo/app:1.2.3', '--method', 'helm'], appRoot(), runner),
    );
    expect(result.ok).toBe(false);
    expect(result.findings?.[0]?.code).toBe('X_DEPLOY_FAILED');
    expect(result.findings?.[0]?.fix).toBe(
      `${(ran.at(-1) ?? []).join(' ')}   # run it directly to see the full output`,
    );
  });
});

/**
 * `docker-compose.prod.yml` resolves every service's image from `${IMAGE:-ultimate-app:latest}`,
 * so `--image` decided nothing at all on the compose method: `--json` reported the reference the
 * operator asked for while the six `docker compose` steps read `IMAGE` out of the ambient
 * environment — or, unset, deployed `ultimate-app:latest`. The flag and the deploy have to be the
 * same fact.
 */
describe('unit · x deploy --method compose passes the image it reports', () => {
  test('every compose step runs with IMAGE set to the requested reference', async () => {
    const root = appRoot();
    const { runner, ran, envs } = recordingRunner();
    const result = await deployCommand.run(
      runContext(['deploy', '--image', 'ghcr.io/you/app:1.2.3'], root, runner),
    );
    expect(result.ok).toBe(true);
    expect(ran).toHaveLength(DEPLOY_ROLES.length);
    for (const env of envs) expect(env).toEqual({ IMAGE: 'ghcr.io/you/app:1.2.3' });
  });

  // The human render and `--json` are one plan or they are two plans. The terminal showed
  // `docker compose -f … up -d web` with no `IMAGE=` in front of it, so an operator copying the
  // line they were shown deployed the compose file's DEFAULT image while `--json` reported theirs.
  test('the human dry run carries the same IMAGE the JSON plan does', async () => {
    const result = await deployCommand.run(
      contextFor(['deploy', '--image', 'ghcr.io/you/app:1.2.3', '--dry-run'], appRoot()),
    );
    const lines = (result.lines ?? []).join('\n');
    const { env } = result.data as { env: Record<string, string> };
    expect(env).toEqual({ IMAGE: 'ghcr.io/you/app:1.2.3' });
    for (const line of result.lines ?? []) {
      expect(line).toContain('IMAGE=ghcr.io/you/app:1.2.3 docker compose');
    }
    expect(lines).not.toContain('  docker compose');
  });

  // Helm's plan carries no environment, so its rendered line must gain no prefix — a `IMAGE=` in
  // front of `helm upgrade` would name a variable the chart never reads.
  test('a helm dry run renders the bare command, because its env is empty', async () => {
    const result = await deployCommand.run(
      contextFor(
        ['deploy', '--image', 'repo/app:1.2.3', '--method', 'helm', '--dry-run'],
        appRoot(),
      ),
    );
    expect((result.lines ?? []).join('\n')).toContain('all        helm upgrade --install');
  });

  test('the dry run says so too, so the plan an operator reads is the plan that runs', () => {
    expect(planDeploy('repo/app:tag', 'compose', '/app').env).toEqual({ IMAGE: 'repo/app:tag' });
    // Helm carries no IMAGE: the chart reads `--set image.repository/tag`, and an env var the
    // chart never looks at would be a second answer to "which image is this".
    expect(planDeploy('repo/app:tag', 'helm', '/app').env).toEqual({});
  });
});

/**
 * The summary is what an operator READS, and it named `DEPLOY_ROLES` whatever the plan actually
 * was. On `--method helm` the plan is one `helm upgrade --install` and the chart has no `backfill`
 * object at all (`scaffold-helm.ts`'s `roles:` is web|sync|worker|scheduler|replicator plus a
 * `migrate` Job), so the line reported six roles including the post-deploy sweep — and the sweep
 * never ran.
 */
describe('unit · the summary names the roles this plan really has', () => {
  const summaryRoles = (summary: string): readonly string[] =>
    (summary.split('roles ')[1] ?? '').split(',');

  test('helm reports the one step it runs, never compose`s six roles', async () => {
    const root = appRoot();
    const { runner } = recordingRunner();
    const result = await deployCommand.run(
      runContext(
        ['deploy', '--method', 'helm', '--image', 'repo/app:1.2.3', '--dry-run'],
        root,
        runner,
      ),
    );

    expect(summaryRoles(result.summary)).toEqual(['all']);
    expect(result.summary).not.toContain('backfill');
  });

  test('compose still reports every role it really runs', async () => {
    const root = appRoot();
    const { runner } = recordingRunner();
    const result = await deployCommand.run(
      runContext(['deploy', '--image', 'repo/app:1.2.3', '--dry-run'], root, runner),
    );

    expect(summaryRoles(result.summary)).toEqual([...DEPLOY_ROLES]);
  });

  test('and a completed run says the same thing the dry run did', async () => {
    const root = appRoot();
    const { runner } = recordingRunner();
    const result = await deployCommand.run(
      runContext(['deploy', '--method', 'helm', '--image', 'repo/app:1.2.3'], root, runner),
    );

    expect(result.ok).toBe(true);
    expect(summaryRoles(result.summary)).toEqual(['all']);
  });
});
