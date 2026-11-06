// Real-user timings as the budgets step weighs them: off adds nothing, each surface is added only
// when listed, and a document naming the script is CHARGED its bytes — never set aside as a
// framework file the author cannot remove.

import { describe, expect, test } from 'bun:test';
import { CLIENT_VITALS_DEFAULTS } from '@ultimat3/core';
import { FRAMEWORK_SCRIPTS, measureDocumentJs } from './budgets';
import { CLIENT_VITALS_SCRIPT_PATH, clientVitalsScript } from './client-vitals-script';
import { clientVitalsStaticWarning, vitalsBuild } from './prerender-vitals';

const ON = { ...CLIENT_VITALS_DEFAULTS, enabled: true };

describe('vitalsBuild', () => {
  test('off, or absent, adds no head and no script', () => {
    expect(vitalsBuild(undefined)).toEqual({});
    expect(vitalsBuild(CLIENT_VITALS_DEFAULTS)).toEqual({});
  });

  test('the default lists app alone: the static path carries none of it', () => {
    const build = vitalsBuild(ON);
    expect(build.appHead).toContain(CLIENT_VITALS_SCRIPT_PATH);
    expect(build.siteHead).toBeUndefined();
    expect(clientVitalsStaticWarning(build)).toEqual([]);
  });

  test('site listed is a site head, the rate in the script, and a warning for static hosts', () => {
    const build = vitalsBuild({ ...ON, sampleRate: 0.25, surfaces: ['site'] });
    expect(build.appHead).toBeUndefined();
    expect(build.siteHead).toContain(CLIENT_VITALS_SCRIPT_PATH);
    expect(build.script?.code).toBe(clientVitalsScript(0.25));
    expect(clientVitalsStaticWarning(build)).toHaveLength(1);
  });
});

describe('the budgets step charges the script', () => {
  test('a document naming it is charged every byte the process serves for it', async () => {
    const build = vitalsBuild(ON);
    const code = build.script?.code ?? expect.unreachable('vitals on carries the script');
    const measured = await measureDocumentJs(
      `<html><head>${build.appHead ?? ''}</head><body></body></html>`,
      '/nonexistent-out',
      { served: new Map([[CLIENT_VITALS_SCRIPT_PATH, code]]) },
    );
    expect(FRAMEWORK_SCRIPTS.has(CLIENT_VITALS_SCRIPT_PATH)).toBe(false);
    expect(measured.jsBytes).toBe(Buffer.byteLength(code, 'utf8'));
    expect(measured.frameworkBytes).toBe(0);
  });
});
