// The runtime loads under test and hands both boots the partner authorization server's routes and
// the GitHub sign-in legs — and loads nothing that constructs an `Auth`: every role imports this file before its boot
// installs the shared rate limiter and replay guard a `defineAuth()` call would capture.
import { expect, unitTest } from '@ultimat3/testing';
import { SIGN_IN_CALLBACK_PATH, SIGN_IN_START_PATH } from './app/auth/sign-in-routes';
import { partnerOAuth } from './app/partners/oauth';
import { runtime } from './runtime';

const mounts = (routes: readonly { readonly method: string; readonly path: string }[]) =>
  routes.map((route) => `${route.method} ${route.path}`);

unitTest('the runtime loads and mounts the authorization server and the sign-in legs', () => {
  // No IdP is configured under test, so the SAML ACS adds nothing (`app/auth/sso-routes.test.ts`).
  expect(mounts(runtime.routes)).toEqual([
    ...mounts(partnerOAuth.routes),
    `GET ${SIGN_IN_START_PATH}`,
    `GET ${SIGN_IN_CALLBACK_PATH}`,
  ]);
});

/** Every app file `from` reaches through STATIC imports — a dynamic `import()` loads on use. */
const dirOf = (file: string): string => file.slice(0, file.lastIndexOf('/'));

async function staticGraph(from: string): Promise<ReadonlySet<string>> {
  const scanner = new Bun.Transpiler({ loader: 'ts' });
  const seen = new Set<string>();
  const queue = [from];
  for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
    if (seen.has(file)) continue;
    seen.add(file);
    for (const entry of scanner.scanImports(await Bun.file(file).text())) {
      if (entry.kind !== 'import-statement' || !entry.path.startsWith('.')) continue;
      queue.push(Bun.resolveSync(entry.path, dirOf(file)));
    }
  }
  return seen;
}

unitTest('importing the runtime constructs no Auth', async () => {
  const reached = await staticGraph(`${import.meta.dir}/runtime.ts`);
  const code = new Bun.Transpiler({ loader: 'tsx' });
  const building = [];
  for (const file of reached) {
    // Transpiled, so a comment naming `defineAuth()` is not a call.
    const js = code.transformSync(await Bun.file(file).text());
    if (/\b(?:defineAuth|postlyAuth)\(/.test(js)) building.push(file);
  }
  expect(building).toEqual([]);
  // The one that does — Postly's `auth` — is behind the sign-in legs' first request, not this import.
  expect([...reached].some((file) => file.endsWith('/app/auth/login.ts'))).toBe(false);
  expect([...reached].some((file) => file.endsWith('/app/auth/sign-in-routes.ts'))).toBe(true);
});
