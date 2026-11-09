// The browser read client is what every island with a `useQuery` carries; it must not carry an
// error-titles TABLE — core's own, schema's, or this package's (`errors.ts` registers the whole
// code table at import). Measured on the artifact: `Bun.build` with `minify: false` writes one
// `// <path>` banner per retained module, so the retained SET is read off the chunk and a
// regression names its file.

import { afterAll, describe, expect, test } from 'bun:test';
// why: Bun ships no directory-removal API, and the fixture directory is this process's own.
import { rm } from 'node:fs/promises';
// why: Bun ships no path API; the entry is written INSIDE the package so `@ultimat3/*` resolves
// through the workspace, and each banner is resolved back to an absolute path.
import { join, resolve } from 'node:path';

/** Gitignored repo-wide; one directory per process so concurrent runs never delete each other. */
const FIXTURE_DIR = join(import.meta.dir, '..', '.tmp', `client-bundle-${process.pid}`);
const PACKAGES = resolve(import.meta.dir, '..', '..');

afterAll(async () => {
  await rm(FIXTURE_DIR, { recursive: true, force: true });
});

async function build(minify: boolean): Promise<{ modules: string[]; bytes: number }> {
  const entry = join(FIXTURE_DIR, `client-${minify ? 'min' : 'banners'}.ts`);
  await Bun.write(
    entry,
    "import { queryClient } from '@ultimat3/query/client';\nglobalThis.probe = queryClient;\n",
  );
  const built = await Bun.build({ entrypoints: [entry], target: 'browser', format: 'esm', minify });
  const output = built.outputs[0];
  if (!built.success || output === undefined) {
    return expect.unreachable(`the client did not bundle: ${built.logs.map(String).join('; ')}`);
  }
  const modules: string[] = [];
  for (const line of (await output.text()).split('\n')) {
    if (!line.startsWith('// ')) continue;
    const path = resolve(process.cwd(), line.slice(3));
    if (path.startsWith(`${PACKAGES}/`) && (await Bun.file(path).exists())) {
      modules.push(path.slice(PACKAGES.length + 1));
    }
  }
  return { modules: modules.sort(), bytes: output.size };
}

/** Any schema module is a table, except the one-symbol `error-brand.ts` `UltimateError` brands with. */
const isTitlesTable = (module: string): boolean =>
  module === 'core/src/core-error-codes.ts' ||
  module === 'core/src/schema-error-codes.ts' ||
  module === 'query/src/errors.ts' ||
  (module.startsWith('schema/src/') && module !== 'schema/src/error-brand.ts');

describe('@ultimat3/query/client in a browser', () => {
  test('reaches no titles table', async () => {
    const { modules } = await build(false);
    expect(modules).toContain('query/src/client.ts');
    expect(modules.filter(isTitlesTable)).toEqual([]);
  }, 60_000);

  // measured: 15,628 B (2026-11-05), against 15,872, the next half kilobyte. why: +506 B,
  // `renderedQueryPin` (core's `client-paths-pins.ts`): a read the server pinned is fetched where
  // the document's `<meta name="ultimate-pins">` says when it is reached by NAME (`queryClient`,
  // `useQuery`, a channel's catch-up), so no browser ref restates the pin.
  // was: 15,122 B (2026-11-05), against 15,360, the next half kilobyte. why: +628 B over
  // 14,494: +96 B, core's `fillWire` — the one pinned-URL/body split `action.client()`, this client
  // and `useMutation` now share instead of three copies — and +532 B, wave 5b's core `./page`
  // changes this client reaches through the transport and `fillTemplate` (the dot-segment refusal
  // and its reason, the session-lost and dispatch edits).
  // was: 14,494 B (2026-11-05), against 14,848, the next half kilobyte. why: +1,013 B, a
  // pinned read's URL — core's `fillTemplate`/`templateParams` and `X_QUERY_HTTP_PATH_INVALID`'s leaf class, so
  // `client()` on `http: { path: '/orders/:id' }` fills the URL rather than 404ing on the derived
  // one; the other +697 B over 12,746 is wave 5a's core `./page` additions (13,443 B without
  // this). measured: 12,746 B (2026-10-09, Bun 1.4.2), against 13,312. why: +763 B, core's
  // `reviveWireDates`: a row's `Date` reaches the caller as a `Date`, named by the route in
  // `x-ultimate-dates` (#710). 11,983 B on 2026-10-05; it was 11,012 at the tip before
  // this change. why: +971 B, core's decoders reading an http refusal off the wire — the
  // `Retry-After` reader (`client-retry-after.ts`) and the `retry-after` rule in `retryForStatus`,
  // so a read refused with a 429 waits the delay the server named, and the problem body's `title`
  // for a code this realm never registered (`remoteTitleOf`). The next whole kilobyte above it.
  // measured: 15,997 B (2026-11-09, Bun 1.4.4), 15,784 without this change. why: +213 B, core's
  // `boundedCause` in `UltimateError`'s constructor — every cause, a decoded problem's included, is
  // cut at 4 KiB (plan 101 slice 02, K2). The ceiling moves by the measured growth: 15,872 + 213.
  test('stays under 16.1 kB minified (15,997 B as of 2026-11-09)', async () => {
    const { bytes } = await build(true);
    expect(bytes).toBeLessThan(16_085);
  }, 60_000);
});
