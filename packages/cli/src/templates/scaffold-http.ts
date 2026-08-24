// The scaffold's answer to "how does this server bind, and what does it admit?", which it did not
// have. `configureHttp()` is the one registration site an app has for CORS origins, the body
// limit, the request deadline, the in-flight ceiling and the rate-limit buckets — and until it
// shipped, the only `HttpConfig` any process built was a fixed literal inside `@ultimat3/cli`.
//
// `DEFAULT_CORS.origins` is `[]`, so a scaffolded app refuses every cross-origin browser call. The
// most common homework-scale need — a Vite front end on `localhost:5173` calling the app — was
// inexpressible; now it is one uncommented line, and this file is where an agent finds it.

import type { GeneratedFile, NameSet } from './naming';

const httpConfig = (
  app: NameSet,
): string => `// What this app declares about HTTP. Module scope IS the wiring: the boot scan imports every
// module under \`apps/*\` before a listener binds, and \`x dev\` and the container both read the
// configured value back at start — the same seam \`app/auth/dev-actor.ts\` installs through.
//
// The BOOT lays its own facts over whatever this says: \`port\`, \`hostname\`, \`dev\`, \`buildId\`,
// \`signInPath\`, \`trustProxy\`, \`trustedProxyHops\` and \`rateLimit.scope\` are all facts about the
// PROCESS, so writing one here is a type error rather than a value silently overwritten at the
// next boot.

import { configureHttp } from '@ultimat3/http';

configureHttp({
  // EMPTY by default, and that is a refusal rather than an oversight: an origin list is a list of
  // sites allowed to make credentialed calls with this app's cookies, and a framework may not
  // guess one. A browser app served from another origin — a Vite dev server, a separate marketing
  // site — goes here, exactly spelled, scheme and port included:
  //
  //   cors: { origins: ['http://localhost:5173'] },
  //
  // \`credentials\` is \`true\` by default, and \`'*'\` with credentials is the one combination a
  // browser refuses — \`@ultimat3/http\` refuses it here instead, at the moment you can act on it.
  cors: { origins: [] },
  // The two bounds a request is measured against. Both are the framework's defaults spelled out,
  // so raising one for an endpoint that really does take a 4 MB CSV or five minutes is an edit to
  // a number that is already in front of you rather than a search for the knob.
  bodyLimitBytes: 1024 * 1024,
  requestTimeoutMs: 30_000,
});

/** Named so the module has an export; importing it for the side effect alone is the wiring. */
export const ${app.camel}Http = 'configured';
`;

const httpConfigTest =
  (): string => `// The declaration reached the registry. \`configureHttp()\` is a module-scope side effect, so the
// only thing that can go wrong is nobody importing the module — which is exactly how a shipped app
// rendered every string as ⟦key⟧ for a whole release (issue #249), one seam along.
import { configuredHttp, resetHttpConfig } from '@ultimat3/http';
import { expect, unitTest } from '@ultimat3/testing';
import './http';

unitTest('importing the module IS the registration', () => {
  const declared = configuredHttp();
  expect(declared).toBeDefined();
  // The list is empty on a fresh scaffold and that is the shipped default; what is asserted is
  // that the KEY reaches the boot, so adding an origin to it takes effect.
  expect(declared?.cors?.origins).toEqual([]);
});

unitTest('the boot-owned keys are absent — the boot measures them, an app can only guess', () => {
  const declared = configuredHttp() ?? {};
  for (const key of ['port', 'hostname', 'dev', 'buildId', 'signInPath']) {
    expect({ key, declared: Object.hasOwn(declared, key) }).toEqual({ key, declared: false });
  }
});

// The registration is process-global, so a suite that left it set would hand the next file this
// app's config. \`resetHttpConfig()\` is the seam; this is the one place it is called.
unitTest('and it is resettable, so no test file inherits the server config of another', () => {
  resetHttpConfig();
  expect(configuredHttp()).toBeUndefined();
});
`;

/** `apps/web/app/http.ts` and its test. Written by `x new`, with or without the example slice. */
export function httpFiles(app: NameSet): readonly GeneratedFile[] {
  return [
    { path: 'apps/web/app/http.ts', contents: httpConfig(app) },
    { path: 'apps/web/app/http.test.ts', contents: httpConfigTest() },
  ];
}
