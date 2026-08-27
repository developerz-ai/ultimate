// Single responsibility: what an app's own `configureHttp()` declaration does to the web role this
// process really starts. Split from `dev-roles.test.ts` for the reason `dev-roles-csp.test.ts` is:
// it asks nothing about which roles start, it asks whether the one that started is configured by
// the app or by a literal in the CLI.
//
// The bug it pins: `startWeb`'s `defineHttpConfig({...})` was a FIXED literal passing eight boot
// facts and nothing else, and it was the only construction any shipped process made — so
// `cors.origins` was `[]` in every deployment (no cross-origin call could ever succeed),
// `bodyLimitBytes` was 1 MiB and `requestTimeoutMs` 30s, for a bank and a blog alike, with no
// value an operator could set anywhere that would change one of them.

import { afterEach, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises'; // why: Bun has no recursive remove, only a per-file delete.
import { configureHttp, resetHttpConfig } from '@ultimat3/http';
import { appRoutes } from './dev-render';
import type { RunningRoles } from './dev-roles';
import { selectRoles, startRoles } from './dev-roles';
import { fixtureRuntime, resetDevRolesState } from './dev-roles-fixture';

const ROOT = `${import.meta.dir}/../.roles-http-config-fixture`;

let running: RunningRoles | undefined;

afterEach(async () => {
  await running?.stop();
  running = undefined;
  resetDevRolesState();
  // Process-global, exactly as the authenticator is — and this file is the one that sets it.
  resetHttpConfig();
  await rm(ROOT, { recursive: true, force: true });
});

const web = async (): Promise<RunningRoles> =>
  await startRoles({
    roles: selectRoles('web'),
    port: 0,
    buildId: 'test',
    runtime: fixtureRuntime(ROOT),
    env: {},
    routes: appRoutes({ buildId: 'test' }),
    http: { dev: false, hostname: 'localhost' },
  });

describe("the web role serves the app's own HTTP declaration", () => {
  test('a declared CORS origin is answered, and an undeclared one is still refused', async () => {
    configureHttp({
      cors: { origins: ['https://app.example.test'], credentials: false },
    });
    running = await web();

    const allowed = await running.server?.fetch(
      new Request('http://dev.test/_x', { headers: { origin: 'https://app.example.test' } }),
    );
    const refused = await running.server?.fetch(
      new Request('http://dev.test/_x', { headers: { origin: 'https://evil.example.test' } }),
    );

    expect(allowed?.headers.get('access-control-allow-origin')).toBe('https://app.example.test');
    expect(refused?.headers.get('access-control-allow-origin')).toBeNull();
  });

  test("the boot's own CSP hashes survive an app that extends the same directive", async () => {
    configureHttp({
      security: { csp: { extend: { 'script-src': ['https://cdn.example.test'] } } },
    });
    running = await web();

    const csp =
      (await running.server?.fetch(new Request('http://dev.test/_x')))?.headers.get(
        'content-security-policy',
      ) ?? '';
    // The one directive both halves declare. Read alone, because the BASELINE `style-src` already
    // carries a hash of its own — asserting a `sha256-` anywhere in the header would pass with the
    // script half missing entirely, which is the state this test exists to refuse.
    const scriptSrc =
      csp
        .split(';')
        .map((directive) => directive.trim())
        .find((directive) => directive.startsWith('script-src ')) ?? '';

    // Both, or one of the two is broken: the app's CDN script, or every island's hydration
    // runtime — which is emitted inline and admitted only by the hash this boot computed.
    expect(scriptSrc).toContain('https://cdn.example.test');
    expect(scriptSrc).toContain("'sha256-");
  });

  test('a boot fact still wins: the app cannot move the port this process was told to bind', async () => {
    // `port` is not on `AppHttpConfig` at all, so this is the runtime half of a type-level rule.
    configureHttp({ bodyLimitBytes: 32 });
    running = await web();

    expect(running.url).not.toBeNull();
    expect(running.url).not.toContain(':3000');
  });
});
