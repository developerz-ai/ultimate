// The shape of `.github/workflows/actions-cache.yml` that keeps the prune real: it applies, it runs
// often enough to outpace CodeQL's saves, and a red prune reaches the alarm. Reads the REAL workflow.

import { describe, expect, test } from 'bun:test';
import { BOT_ALARMS } from './lib/health-bot-issues';
import { repoRoot } from './lib/run';

interface Step {
  readonly id?: string;
  readonly if?: string;
  readonly run?: string;
  readonly 'continue-on-error'?: boolean;
}

interface Workflow {
  readonly on?: { readonly schedule?: readonly { readonly cron: string }[] };
  readonly permissions?: Readonly<Record<string, string>>;
  readonly jobs?: Readonly<Record<string, { readonly steps?: readonly Step[] }>>;
}

const workflow = Bun.YAML.parse(
  await Bun.file(`${repoRoot()}/.github/workflows/actions-cache.yml`).text(),
) as Workflow;
const steps = workflow.jobs?.['prune']?.steps ?? [];
const prune = steps.find((step) => step.id === 'prune');

describe('unit · actions-cache.yml prunes hourly and raises its alarm', () => {
  test('hourly, holding only what deleting and the alarm need', () => {
    expect(workflow.on?.schedule?.[0]?.cron).toMatch(/^\d+ \* \* \* \*$/);
    expect(workflow.permissions).toEqual({
      actions: 'write',
      contents: 'read',
      issues: 'write',
    });
  });

  test('the prune applies, and pipefail keeps its exit status past tee', () => {
    expect(prune?.run).toContain('scripts/actions-cache-prune.ts --apply --json');
    expect(prune?.run).toContain('set -o pipefail');
    expect(prune?.['continue-on-error']).toBe(true);
  });

  test('a red prune files the alarm and still fails the run; a clean one closes it', () => {
    const on = (outcome: string) =>
      steps.filter((step) => step.if === `steps.prune.outcome == '${outcome}'`);
    expect(on('failure').map((step) => step.run?.includes('gh issue create'))).toContain(true);
    expect(on('failure').at(-1)?.run).toBe('exit 1');
    expect(on('success')[0]?.run).toContain('gh issue close');
    expect(BOT_ALARMS['actions-cache']).toBe('actions-cache.yml');
  });
});
