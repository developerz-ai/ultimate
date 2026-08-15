// `x deploy` emits a plan, and the plan's ORDER is the contract: `migrate` gates the release,
// `backfill` trails every serving role. A backfill inside the release gate holds the deploy open
// while a slow UPDATE runs against a database still serving the previous build, which is the one
// arrangement this file exists to keep out.

import { describe, expect, test } from 'bun:test';
import { DEPLOY_ROLES, deployCommand, planDeploy } from './cmd-deploy';

const compose = (root = '/app') => planDeploy('repo/app:tag', 'compose', root);

describe('unit · the deploy plan', () => {
  test('migrate is first and backfill is LAST — deploy triggers, deploy never gates', () => {
    expect(DEPLOY_ROLES[0]).toBe('migrate');
    expect(DEPLOY_ROLES.at(-1)).toBe('backfill');
    const roles = compose().steps.map((step) => step.role);
    expect(roles.indexOf('backfill')).toBeGreaterThan(roles.indexOf('web'));
    expect(roles.indexOf('backfill')).toBeGreaterThan(roles.indexOf('worker'));
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

  test('the command declares every flag its own usage line names', () => {
    const flags = deployCommand.spec.flags?.map((flag) => flag.name) ?? [];
    for (const flag of ['image', 'method', 'dry-run', 'critical']) expect(flags).toContain(flag);
  });
});
