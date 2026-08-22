// `x deploy` — containers only. The framework knows about images, roles and a registry; it does
// not know the name of a cloud, a KV store or an edge runtime (axiom 7). What it emits is a plan
// anything that runs containers can execute.

import { join } from 'node:path';
import { requireAppRoot } from './app-root';
import type { CliCommand, CommandContext } from './command';
import { BadFlagError, UnknownCommandError } from './errors';
import { msg } from './messages';
import type { CommandResult, JsonValue } from './output';
import { flagBool, flagString } from './parse';
import { quoteArg } from './shell-quote';

/**
 * Ordered, and the order is the design. `migrate` GATES — it runs to completion before anything
 * serves, and a schema difference after it fails the deploy. `backfill` is last and TRIGGERS: a
 * data sweep put inside a release gate holds the deploy open while a slow UPDATE runs against a
 * database still serving the PREVIOUS release, so it runs after the new pods are up and the
 * workers already draining the queue are what perform it. That is also why it is not wired into
 * `runMigrations()` and never will be.
 *
 * `backfill` is a one-shot like `migrate`, so it takes the same `run --rm` shape; the compose
 * service behind it runs `x db backfill --all --write --json` rather than a `ROLE`, because
 * `@ultimat3/core`'s `ROLES` is a closed list of process shapes and a sweep trigger is a command.
 *
 * ORDER HERE IS NECESSARY AND NOT SUFFICIENT. `docker compose up -d` returns when a container has
 * STARTED, not when the application inside it is serving, so this list alone puts the trigger after
 * the serving roles were asked to start and not after they are ready. The barrier that makes
 * "after" true is declarative and belongs to the compose file, not to this plan: the `backfill`
 * service needs `depends_on: { web: { condition: service_healthy } }`, which `docker compose run`
 * honours. Both compose definitions carry it — `docker/docker-compose.prod.yml`'s `backfill` and
 * the one `templates/scaffold-container.ts` scaffolds, which also gates on `migrate` completing.
 * This paragraph said they "still owe" both for as long as they have had them.
 */
export const DEPLOY_ROLES = ['migrate', 'web', 'sync', 'worker', 'scheduler', 'backfill'] as const;

/** The two ways to run the plan. Closed, and read three ways: the default, the check, the refusal. */
export const DEPLOY_METHODS = ['compose', 'helm'] as const;

export type DeployMethod = (typeof DEPLOY_METHODS)[number];

/**
 * Refused, never defaulted. `=== 'helm' ? 'helm' : 'compose'` made every other spelling a Compose
 * deploy that reported `ok: true` and `method: "compose"` — so `x deploy --method helmm` (or
 * `Helm`, or `kubectl`) ran the six-step Compose plan against a cluster whose operator had asked
 * for a Helm upgrade, and the report agreed with the plan rather than with the request.
 * `cmd-build.ts`'s `readTarget` is the same shape for the same reason.
 */
export function readMethod(raw: string | undefined): DeployMethod {
  const methods: readonly string[] = DEPLOY_METHODS;
  if (raw === undefined) return 'compose';
  if (methods.includes(raw)) return raw as DeployMethod;
  throw new UnknownCommandError({
    path: `deploy --method ${raw}`,
    known: DEPLOY_METHODS,
    suggestion: 'deploy --method compose',
  });
}

/** The roles that run to completion and exit, as against the ones that stay up serving. */
const ONE_SHOT_ROLES: readonly string[] = ['migrate', 'backfill'];

export interface DeployPlan {
  readonly image: string;
  /** Ordered: migrate runs to completion before any role that serves traffic starts. */
  readonly steps: readonly { readonly role: string; readonly command: readonly string[] }[];
  /**
   * The environment every step runs with — how the COMPOSE method carries the image, because
   * `docker-compose.prod.yml` resolves each service from `${IMAGE:-ultimate-app:latest}` and
   * `docker compose` takes no image argument. Without it `--image` decided nothing: the plan
   * reported the reference the operator asked for while the six steps read `IMAGE` off the
   * ambient environment, or deployed `ultimate-app:latest` where it was unset. Helm carries none
   * — the chart reads `--set image.repository/tag`, and an env var it never looks at would be a
   * second answer to which image is being deployed.
   */
  readonly env: Readonly<Record<string, string>>;
}

/**
 * The chart declares `image` as a MAP — `repository`, `tag`, `pullPolicy` — and `_helpers.tpl`
 * renders `printf "%s:%s" .Values.image.repository (default .Chart.AppVersion .Values.image.tag)`.
 * `--set image=<ref>` replaces that map with a string, so every workload template fails on
 * `.repository` and the deploy that was asked to ship one image ships nothing. The reference is
 * split into the two keys the chart actually reads; a reference with no tag sets only the
 * repository, which leaves the chart's own `default .Chart.AppVersion` in force.
 *
 * The last `:` after the last `/`, because a registry may carry a port: `localhost:5000/app` is a
 * repository with no tag and `localhost:5000/app:1.2.3` is the same repository with one.
 */
export function helmImageOverrides(image: string): readonly string[] {
  const colon = image.lastIndexOf(':');
  const tag = colon > image.lastIndexOf('/') ? image.slice(colon + 1) : '';
  const repository = tag === '' ? image : image.slice(0, colon);
  return tag === ''
    ? ['--set', `image.repository=${repository}`]
    : ['--set', `image.repository=${repository}`, '--set', `image.tag=${tag}`];
}

export function planDeploy(image: string, method: DeployMethod, root: string): DeployPlan {
  if (method === 'helm') {
    // `repo@sha256:…` is a reference this chart cannot express: it renders `repository:tag` and
    // has no digest branch, so passing one through would deploy `repo@sha256:…:<appVersion>` —
    // a tag no registry has. Refused here rather than by a `helm upgrade` failing halfway.
    if (image.lastIndexOf('@') > image.lastIndexOf('/')) {
      throw new BadFlagError({
        flag: 'image',
        command: 'deploy',
        reason: `"${image}" pins a digest, and docker/helm renders repository:tag with no digest branch`,
        fix: `x deploy --method helm --image ${image.slice(0, image.lastIndexOf('@'))}:<tag> --json`,
      });
    }
    return {
      image,
      env: {},
      steps: [
        {
          role: 'all',
          command: [
            'helm',
            'upgrade',
            '--install',
            'app',
            join(root, 'docker', 'helm'),
            ...helmImageOverrides(image),
          ],
        },
      ],
    };
  }
  return {
    image,
    // The one place the compose file's own variable is named. `docker/docker-compose.prod.yml`'s
    // header documents `IMAGE=… docker compose …` as the way to run it by hand; this is that line,
    // performed.
    env: { IMAGE: image },
    steps: DEPLOY_ROLES.map((role) => ({
      role,
      command: [
        'docker',
        'compose',
        '-f',
        join(root, 'docker', 'docker-compose.prod.yml'),
        ONE_SHOT_ROLES.includes(role) ? 'run' : 'up',
        ONE_SHOT_ROLES.includes(role) ? '--rm' : '-d',
        role,
      ],
    })),
  };
}

/**
 * One step, as the line an operator would type — the environment first, then the command.
 *
 * `plan.env` is the compose file's own `IMAGE=…` variable, and it is what makes `--image` true on
 * that method: a rendered line without it deploys `docker-compose.prod.yml`'s DEFAULT image. Both
 * renderers and the failure `fix:` go through here, so the plan `--json` reports, the plan the
 * terminal shows and the line the refusal hands back can never name three different deployments.
 */
const stepLine = (env: Readonly<Record<string, string>>, command: readonly string[]): string =>
  [...Object.entries(env).map(([name, value]) => `${name}=${quoteArg(value)}`), ...command].join(
    ' ',
  );

export const deployCommand: CliCommand = {
  spec: {
    name: 'deploy',
    summary: 'run the container deploy plan: migrate first, then the serving roles',
    usage: 'x deploy --image repo/app:tag [--method compose|helm] [--dry-run] [--json]',
    requiresApp: true,
    flags: [
      { name: 'image', type: 'string', summary: 'image reference to deploy' },
      { name: 'method', type: 'string', summary: 'compose | helm', default: 'compose' },
      { name: 'dry-run', type: 'boolean', summary: 'print the plan, run nothing' },
      // `--critical` was here and is gone. It parsed, it was echoed into the plan JSON as
      // `critical: <bool>`, and no file in `packages/` read that field — so the flag changed
      // nothing about what `x deploy` did, on either method. `flag-reads.ts`'s
      // `X_CLI_FLAG_UNREAD` passed it, because that gate proves a flag is READ and this one was:
      // into a field with no reader. Forcing a reload is `@ultimat3/pwa`'s
      // `updateSignal({ reason: 'security' })`, which has no runtime caller either; a flag that
      // triggers it is a change in that package, and this was not it.
    ],
  },
  async run(ctx: CommandContext): Promise<CommandResult> {
    const root = requireAppRoot('deploy', ctx.cwd).dir;
    const image = flagString(ctx.args, 'image') ?? 'ultimate-app:dev';
    // No "is there a chart?" branch. It threw X_NOT_IMPLEMENTED — "this build does not implement
    // helm" — over a build that implements it completely (`planDeploy` above); what was missing was
    // a FILE, and its fix said to copy it from the framework repository, which `packages/cli`'s
    // `files:` ships in no tarball. `x new` writes `docker/helm` now, the way it has always written
    // `docker/docker-compose.prod.yml`. An app that deleted the chart gets helm's own error through
    // X_DEPLOY_FAILED, whose fix is the exact command to rerun.
    const method = readMethod(flagString(ctx.args, 'method'));
    const plan = planDeploy(image, method, root);
    const planJson: JsonValue = {
      image: plan.image,
      method,
      // Reported, because it is what makes `image` above true on the compose method — a dry run
      // that names an image the steps do not carry is the defect this field closed.
      env: { ...plan.env },
      steps: plan.steps.map((step) => ({ role: step.role, command: step.command.join(' ') })),
    };
    if (flagBool(ctx.args, 'dry-run')) {
      return {
        ok: true,
        command: 'deploy',
        summary: msg('cli.deploy.plan', { images: 1, roles: DEPLOY_ROLES.join(',') }),
        data: planJson,
        lines: plan.steps.map(
          (step) => `  ${step.role.padEnd(10)} ${stepLine(plan.env, step.command)}`,
        ),
      };
    }
    for (const step of plan.steps) {
      const result = await ctx.runner(step.command, { cwd: root, env: plan.env });
      if (!result.ok) {
        return {
          ok: false,
          command: 'deploy',
          summary: msg('cli.deploy.plan', { images: 1, roles: step.role }),
          findings: [
            {
              code: 'X_DEPLOY_FAILED',
              cause: `role "${step.role}" step exited ${result.code}`,
              fix: `${stepLine(plan.env, step.command)}   # run it directly to see the full output`,
              docs: 'https://ultimate.dev/errors/X_DEPLOY_FAILED',
            },
          ],
          data: planJson,
        };
      }
    }
    return {
      ok: true,
      command: 'deploy',
      summary: msg('cli.deploy.plan', { images: 1, roles: DEPLOY_ROLES.join(',') }),
      data: planJson,
    };
  },
};
