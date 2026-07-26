// `x deploy` — containers only. The framework knows about images, roles and a registry; it does
// not know the name of a cloud, a KV store or an edge runtime (axiom 7). What it emits is a plan
// anything that runs containers can execute.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { requireAppRoot } from './app-root';
import type { CliCommand, CommandContext } from './command';
import { CliNotImplementedError } from './errors';
import { msg } from './messages';
import type { CommandResult, JsonValue } from './output';
import { flagBool, flagString } from './parse';

export const DEPLOY_ROLES = ['migrate', 'web', 'sync', 'worker', 'scheduler'] as const;

export interface DeployPlan {
  readonly image: string;
  /** Ordered: migrate runs to completion before any role that serves traffic starts. */
  readonly steps: readonly { readonly role: string; readonly command: readonly string[] }[];
}

export function planDeploy(image: string, method: 'compose' | 'helm', root: string): DeployPlan {
  if (method === 'helm') {
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
            '--set',
            `image=${image}`,
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
        role === 'migrate' ? 'run' : 'up',
        role === 'migrate' ? '--rm' : '-d',
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
