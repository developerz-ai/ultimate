// Why a step ran no check, in words, and the lines a run prints for each. `applies` answers only
// yes or no, so the reason a step said no is written here, beside the one test that holds every
// step with an `applies` to a reason of its own.

import { APP_CONFIG_FILE } from '@ultimat3/core';
import { MANIFEST_FILENAME } from '@ultimat3/manifest';
import { msg } from './messages';
import type { TestCounts } from './test-counts';
import type { VerifyStepName } from './verify-step';

/** Each `applies` in the step list, as the sentence it would say. A step absent here never skips. */
const APPLIES_REASONS: Partial<Record<VerifyStepName, () => string>> = {
  'package-shape': () => msg('cli.verify.skip.noPackages'),
  contract: () => msg('cli.verify.skip.noTypedFiles', { type: 'contract' }),
  live: () => msg('cli.verify.skip.noTypedFiles', { type: 'live' }),
  job: () => msg('cli.verify.skip.noTypedFiles', { type: 'job' }),
  e2e: () => msg('cli.verify.skip.noTypedFiles', { type: 'e2e' }),
  eval: () => msg('cli.verify.skip.noEval'),
  exercise: () => msg('cli.verify.skip.noApp', { file: APP_CONFIG_FILE }),
  drift: () => msg('cli.verify.skip.noApp', { file: APP_CONFIG_FILE }),
  'contract-diff': () => msg('cli.verify.skip.noManifest', { file: MANIFEST_FILENAME }),
  budgets: () => msg('cli.verify.skip.noApp', { file: APP_CONFIG_FILE }),
  seo: () => msg('cli.verify.skip.noApp', { file: APP_CONFIG_FILE }),
  i18n: () => msg('cli.verify.skip.noApp', { file: APP_CONFIG_FILE }),
  policy: () => msg('cli.verify.skip.noApp', { file: APP_CONFIG_FILE }),
  roadmap: () => msg('cli.verify.skip.noRoadmap', { file: 'docs/idea/14-roadmap.md' }),
};

/** The steps with a written `applies` reason — what the completeness test holds the list to. */
export const stepsWithAppliesReason = (): readonly string[] => Object.keys(APPLIES_REASONS);

/** Why a step whose `applies` said no has nothing to check here. */
export const appliesReason = (step: string): string =>
  (APPLIES_REASONS as Record<string, (() => string) | undefined>)[step]?.() ??
  msg('cli.verify.skip.nothing');

/** Why a suite that spawned ran nothing: the two shapes its counts can take. */
export const ranNothingReason = (tests: TestCounts): string =>
  tests.skipped === 0
    ? msg('cli.verify.ranNothing')
    : msg('cli.verify.allSkipped', { skipped: tests.skipped });

/**
 * What a run adds to the human lines for its zero-check steps: one `skipped:` line each, then —
 * on a floor that is not strict — the one warning naming the steps no `skip` why excuses.
 */
export const skipLines = (
  reasons: Readonly<Record<string, string>>,
  unwaived: readonly string[],
): readonly string[] => [
  ...Object.entries(reasons).map(([step, reason]) => msg('cli.verify.skip.line', { step, reason })),
  ...(unwaived.length === 0 ? [] : [msg('cli.verify.unwaived', { names: unwaived.join(', ') })]),
];
