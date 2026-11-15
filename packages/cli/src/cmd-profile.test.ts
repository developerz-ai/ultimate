// `x profile` against the real boot: the fixture app's own page rendered in this process under
// JavaScriptCore's sampling profiler, and a CPU-bound handler whose hottest function is known.

import { describe, expect, test } from 'bun:test';
import { REQUIRED_BUN } from './app-root';
import { bootDevFixture } from './cmd-dev-boot-fixture';
import type { ProfileTarget } from './cmd-profile';
import { profileCommandOver, profileRoute } from './cmd-profile';
import type { CommandContext } from './command';
import { exec } from './exec';
import { parseArgs } from './parse';
import { SPECS } from './registry';

const dev = bootDevFixture('.dev-profile-fixture');

const ctxFor = (argv: readonly string[]): CommandContext => ({
  args: parseArgs(argv, SPECS),
  cwd: dev.root,
  runner: exec,
  env: {},
  bunVersion: REQUIRED_BUN,
});

let stopped = 0;
const fixtureTarget = async (): Promise<ProfileTarget> => ({
  fetch: (request) => dev.fetchDev(new URL(request.url).pathname + new URL(request.url).search),
  stop: async () => {
    stopped += 1;
  },
});

function spin(n: number): number {
  return n < 2 ? n : spin(n - 1) + spin(n - 2);
}

describe('unit · x profile <route>', () => {
  test('the hottest function of a CPU-bound render is named, with its file and line', async () => {
    const profile = await profileRoute({
      fetch: async () => new Response(String(spin(24))),
      path: '/',
      runs: 10,
      top: 5,
      root: import.meta.dir,
    });
    expect(profile.status).toBe(200);
    expect(profile.summary.samples).toBeGreaterThan(0);
    const [hottest] = profile.summary.hottest;
    expect(hottest?.name).toBe('spin');
    expect(hottest?.file).toBe('cmd-profile.test.ts');
    expect(hottest?.selfPercent).toBeGreaterThan(50);
  });

  test("the fixture app's page is booted, rendered, profiled and reported in --json", async () => {
    stopped = 0;
    const result = await profileCommandOver(fixtureTarget).run(
      ctxFor(['profile', '/pricing', '--runs', '5', '--top', '3', '--json']),
    );
    expect(result.ok).toBe(true);
    const data = result.data as { route: string; status: number; runs: number; hottest: unknown[] };
    expect([data.route, data.status, data.runs]).toEqual(['/pricing', 200, 5]);
    expect(data.hottest.length).toBeLessThanOrEqual(3);
    expect(stopped).toBe(1);
  });

  test('a route that answers an error is profiled and reported red, the boot still stopped', async () => {
    stopped = 0;
    const result = await profileCommandOver(fixtureTarget).run(
      ctxFor(['profile', '/no-such-page']),
    );
    expect(result.ok).toBe(false);
    expect((result.data as { status: number }).status).toBe(404);
    expect(result.findings?.[0]?.code).toBe('X_PROFILE_ROUTE_FAILED');
    expect(stopped).toBe(1);
  });

  test('no route, an absolute URL or a bad --runs is refused before anything boots', async () => {
    stopped = 0;
    const command = profileCommandOver(fixtureTarget);
    for (const argv of [
      ['profile'],
      ['profile', 'https://example.test/'],
      ['profile', '/', '--runs', '0'],
    ]) {
      await expect(command.run(ctxFor(argv))).rejects.toBeUltimateError('X_CLI_BAD_FLAG');
    }
    expect(stopped).toBe(0);
  });
});
