// `x deploy` — containers only. The framework knows about images, roles and a registry; it does
// not know the name of a cloud, a KV store or an edge runtime (axiom 7). What it emits is a plan
// anything that runs containers can execute.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { requireAppRoot } from './app-root';
import type { CliCommand, CommandContext } from './command';
import { BadFlagError, CliNotImplementedError } from './errors';
import { msg } from './messages';
import type { CommandResult, JsonValue } from './output';
import { flagBool, flagString } from './parse';

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
 * honours. Both compose definitions — `docker/docker-compose.prod.yml` and the one
 * `templates/scaffold-container.ts` scaffolds — still owe that service and that condition.
 */
export const DEPLOY_ROLES = ['migrate', 'web', 'sync', 'worker', 'scheduler', 'backfill'] as const;

/** The roles that run to completion and exit, as against the ones that stay up serving. */
const ONE_SHOT_ROLES: readonly string[] = ['migrate', 'backfill'];

export interface DeployPlan {
  readonly image: string;
  /** Ordered: migrate runs to completion before any role that serves traffic starts. */
  readonly steps: readonly { readonly role: string; readonly command: readonly string[] }[];
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

export function planDeploy(image: string, method: 'compose' | 'helm', root: string): DeployPlan {
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
      { name: 'critical', type: 'boolean', summary: 'security deploy: forces clients to reload' },
    ],
  },
  async run(ctx: CommandContext): Promise<CommandResult> {
    const root = requireAppRoot('deploy', ctx.cwd).dir;
    const image = flagString(ctx.args, 'image') ?? 'ultimate-app:dev';
    const method = flagString(ctx.args, 'method') === 'helm' ? 'helm' : 'compose';
    if (method === 'helm' && !existsSync(join(root, 'docker', 'helm'))) {
      throw new CliNotImplementedError({
        feature: 'helm deploy without docker/helm in the app',
        fix: 'copy docker/helm from the framework repo, or use: x deploy --method compose',
      });
    }
    const plan = planDeploy(image, method, root);
    const planJson: JsonValue = {
      image: plan.image,
      method,
      critical: flagBool(ctx.args, 'critical'),
      steps: plan.steps.map((step) => ({ role: step.role, command: step.command.join(' ') })),
    };
    if (flagBool(ctx.args, 'dry-run')) {
      return {
        ok: true,
        command: 'deploy',
        summary: msg('cli.deploy.plan', { images: 1, roles: DEPLOY_ROLES.join(',') }),
        data: planJson,
        lines: plan.steps.map((step) => `  ${step.role.padEnd(10)} ${step.command.join(' ')}`),
      };
    }
    for (const step of plan.steps) {
      const result = await ctx.runner(step.command, { cwd: root });
      if (!result.ok) {
        return {
          ok: false,
          command: 'deploy',
          summary: msg('cli.deploy.plan', { images: 1, roles: step.role }),
          findings: [
            {
              code: 'X_DEPLOY_FAILED',
              cause: `role "${step.role}" step exited ${result.code}`,
              fix: `${step.command.join(' ')}   # run it directly to see the full output`,
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
