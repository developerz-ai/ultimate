// `x deploy` emits a plan, and the plan's ORDER is the contract: `migrate` gates the release,
// `backfill` trails every serving role. A backfill inside the release gate holds the deploy open
// while a slow UPDATE runs against a database still serving the previous build, which is the one
// arrangement this file exists to keep out.

import { describe, expect, test } from 'bun:test';
import { DEPLOY_ROLES, deployCommand, helmImageOverrides, planDeploy } from './cmd-deploy';

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
    for (const flag of ['image', 'method', 'dry-run', 'critical']) expect(flags).toContain(flag);
  });
});
