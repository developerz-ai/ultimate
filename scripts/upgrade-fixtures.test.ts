// The harness's inputs: the four releases the plan names, a `--versions` that is releases only, and
// HEAD's version read off a manifest that might not carry one — never a `0.0.0` to hop to.

import { describe, expect, test } from 'bun:test';
import { FIXTURE_VERSIONS, headVersionOf, readVersions } from './upgrade-fixtures';

describe('upgrade-fixtures', () => {
  test('the default set is the plan`s four scaffolds, oldest first', () => {
    expect(FIXTURE_VERSIONS).toEqual(['31.4.0', '31.15.0', '31.20.0', '31.22.0']);
    expect(readVersions([])).toBe(FIXTURE_VERSIONS);
  });

  test('--versions takes releases, and refuses a range or a prerelease with the coded flag error', () => {
    expect(readVersions(['31.22.1'])).toEqual(['31.22.1']);
    for (const bad of ['^31.4.0', '31.4', '32.0.0-rc.1']) {
      expect(() => readVersions([bad])).toThrow(
        expect.objectContaining({ code: 'X_CLI_BAD_FLAG' }),
      );
    }
  });

  test('HEAD`s version is a release off the CLI manifest, or nothing to hop to', () => {
    expect(headVersionOf({ name: '@ultimat3/cli', version: '31.27.0' })).toBe('31.27.0');
    expect(headVersionOf({ version: 'workspace:*' })).toBeUndefined();
    expect(headVersionOf({})).toBeUndefined();
    expect(headVersionOf(undefined)).toBeUndefined();
  });
});
