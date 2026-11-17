// `siteAt` splits a finding's `at` into the file and line an `edit` fix opens at.

import { describe, expect, test } from 'bun:test';
import { siteAt } from './site-at';

describe('siteAt', () => {
  test('a path:line splits at the LAST colon', () => {
    expect(siteAt('wiki/Upgrading.md:12')).toEqual({ path: 'wiki/Upgrading.md', line: '12' });
    expect(siteAt('C:/repo/a.md:3')).toEqual({ path: 'C:/repo/a.md', line: '3' });
  });

  test('an at with no line names the top of the file', () => {
    expect(siteAt('packages/x/package.json')).toEqual({
      path: 'packages/x/package.json',
      line: '1',
    });
    expect(siteAt('a.md:top')).toEqual({ path: 'a.md:top', line: '1' });
  });
});
