// The runtime loads under test and hands both boots the partner authorization server's routes —
// and loads nothing that constructs an `Auth`: every role imports this file before its boot
// installs the shared rate limiter and replay guard a `defineAuth()` call would capture.
import { expect, unitTest } from '@ultimat3/testing';
import { partnerOAuth } from './app/partners/oauth';
import { runtime } from './runtime';

unitTest('the runtime loads and mounts the authorization server routes', () => {
  // No IdP is configured under test, so the SAML legs add nothing (`app/auth/sso-routes.test.ts`).
  expect(runtime.routes).toEqual([...partnerOAuth.routes]);
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
  // The one that does — Postly's `auth` — is behind the SSO legs' first request, not this import.
  expect([...reached].some((file) => file.endsWith('/app/auth/login.ts'))).toBe(false);
  expect([...reached].some((file) => file.endsWith('/app/auth/sso-routes.ts'))).toBe(true);
});
