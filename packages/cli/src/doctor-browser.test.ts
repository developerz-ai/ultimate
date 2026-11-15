// `x doctor`'s browser report: the binary the e2e driver would launch, or none — a warning only
// where `x.verify.json` requires `e2e`, and the report line names the install command either way.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
// why: Bun ships no temp-directory primitive and no recursive delete.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(); only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun ships no path-join primitive.
import { join } from 'node:path';
import { browserProbe, browserWarnings, withBrowserReport } from './doctor-browser';
import type { CommandResult } from './output';
import { browserInstallCommand, E2E_BROWSER_MISSING } from './verify-e2e';
import { VERIFY_FLOOR_FILE } from './verify-floor';

const noChrome = { CHROME_PATH: '/nonexistent/chrome-for-the-doctor' };
const decided: CommandResult = { ok: true, command: 'doctor', summary: 's', data: { count: 0 } };

describe('unit · x doctor · the e2e browser', () => {
  let root = '';
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'x-doctor-browser-'));
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test('none found with e2e floored: one warning carrying the install command, verdict kept', async () => {
    await Bun.write(join(root, VERIFY_FLOOR_FILE), JSON.stringify({ steps: ['e2e'] }));
    const fact = await browserProbe(root, noChrome, 'linux');
    expect(fact?.path).toBeUndefined();
    const warnings = browserWarnings(fact);
    expect(warnings.map((warning) => warning.code)).toEqual([E2E_BROWSER_MISSING]);
    expect(warnings[0]?.fix.startsWith(browserInstallCommand('linux'))).toBe(true);
    const reported = withBrowserReport(decided, fact);
    expect(reported.ok).toBe(true);
    expect(reported.data).toEqual({ count: 0, browser: { path: null, e2eRequired: true } });
    expect(reported.lines?.[0]).toContain(browserInstallCommand('linux'));
  });

  test('none found and e2e not floored: reported, never warned', async () => {
    await Bun.write(join(root, VERIFY_FLOOR_FILE), JSON.stringify({ steps: ['unit'] }));
    const fact = await browserProbe(root, noChrome, 'linux');
    expect(browserWarnings(fact)).toEqual([]);
    expect(withBrowserReport(decided, fact).data).toMatchObject({
      browser: { path: null, e2eRequired: false },
    });
  });

  test('a browser found is named, by the path the driver would launch', () => {
    const fact = {
      path: '/usr/bin/google-chrome',
      required: true,
      missing: { code: E2E_BROWSER_MISSING, cause: 'c', fix: 'f' },
      install: 'i',
    };
    expect(browserWarnings(fact)).toEqual([]);
    const reported = withBrowserReport(decided, fact);
    expect(reported.data).toMatchObject({ browser: { path: '/usr/bin/google-chrome' } });
    expect(reported.lines).toEqual(['e2e browser: /usr/bin/google-chrome']);
  });

  test('outside an app there is nothing to report', async () => {
    expect(await browserProbe(undefined, noChrome)).toBeUndefined();
    expect(withBrowserReport(decided, undefined)).toBe(decided);
    expect(browserWarnings(undefined)).toEqual([]);
  });
});
