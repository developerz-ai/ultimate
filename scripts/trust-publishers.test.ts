// The environment is the half of a trusted publisher that nothing else can enforce: `release.yml`
// declares `environment: npm-publish`, and a publisher configured without one accepts a token
// minted by ANY environment — so the reviewer and `v*` tag rules stop applying while every UI and
// every `--check` still reads "configured".

import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_ENVIRONMENT,
  DEFAULT_REPO,
  DEFAULT_WORKFLOW,
  hasPublisher,
  trustArgs,
} from './trust-publishers';

const listed = (extra: Record<string, unknown>): string =>
  JSON.stringify({
    id: 'b02ce1e0',
    type: 'github',
    file: DEFAULT_WORKFLOW,
    repository: DEFAULT_REPO,
    ...extra,
  });

describe('the environment reaches npm', () => {
  test('trustArgs names the environment the workflow declares', () => {
    const args = trustArgs('@ultimat3/core', DEFAULT_REPO, DEFAULT_WORKFLOW);
    const at = args.indexOf('--environment');
    expect(at).toBeGreaterThan(-1);
    expect(args[at + 1]).toBe(DEFAULT_ENVIRONMENT);
    // `--allow-publish` is required for configurations created after 2026-05-20.
    expect(args).toContain('--allow-publish');
  });

  test('an explicit environment overrides the default', () => {
    const args = trustArgs('@ultimat3/core', DEFAULT_REPO, DEFAULT_WORKFLOW, 'staging-publish');
    expect(args[args.indexOf('--environment') + 1]).toBe('staging-publish');
  });
});

describe('a publisher without the environment is NOT configured', () => {
  test('the shape npm returned for a hand-made publisher is refused', () => {
    // Verbatim from `npm trust list @ultimat3/core --json` after the UI form was filled in with
    // the Environment box left blank. This is the case the check exists for.
    expect(
      hasPublisher(listed({ permissions: ['createPackage'] }), DEFAULT_REPO, DEFAULT_WORKFLOW),
    ).toBe(false);
  });

  test('a publisher naming a DIFFERENT environment is refused', () => {
    expect(
      hasPublisher(listed({ environment: 'something-else' }), DEFAULT_REPO, DEFAULT_WORKFLOW),
    ).toBe(false);
  });

  test('a publisher naming this environment is accepted', () => {
    expect(
      hasPublisher(listed({ environment: DEFAULT_ENVIRONMENT }), DEFAULT_REPO, DEFAULT_WORKFLOW),
    ).toBe(true);
  });

  test('the repo and workflow still have to match', () => {
    const env = { environment: DEFAULT_ENVIRONMENT };
    expect(hasPublisher(listed(env), 'someone-else/ultimate', DEFAULT_WORKFLOW)).toBe(false);
    expect(hasPublisher(listed(env), DEFAULT_REPO, 'other.yml')).toBe(false);
  });

  test('an absent environment is refused even when the caller asked for none', () => {
    // The bypass: `--environment=""` made both sides '' , so the ungated publisher matched and the
    // check reported it configured. Asking for nothing must never make nothing acceptable.
    expect(hasPublisher(listed({}), DEFAULT_REPO, DEFAULT_WORKFLOW, '')).toBe(false);
    expect(hasPublisher(listed({ environment: '' }), DEFAULT_REPO, DEFAULT_WORKFLOW, '')).toBe(
      false,
    );
  });

  test('trustArgs always names an environment, so the flag cannot be dropped', () => {
    const args = trustArgs('@ultimat3/core', DEFAULT_REPO, DEFAULT_WORKFLOW, '');
    expect(args).toContain('--environment');
  });

  test('junk is refused rather than thrown on', () => {
    expect(hasPublisher('not json', DEFAULT_REPO, DEFAULT_WORKFLOW)).toBe(false);
  });
});
