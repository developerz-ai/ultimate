/**
 * `<UiProvider>` belongs to an island and to nothing else, and this is the rule as a build error.
 *
 * The shell carried one until 2026-08. A Provider needs a reactive owner, a server render has none,
 * so `@ultimat3/ui` throws `X_UI_RUNTIME_MISSING` rather than dropping the values silently — which
 * meant every `app/` page answered 500 the moment its 401 was lifted, and no test in this app could
 * see it: `tsconfig.json` sets `jsx: "preserve"`, so a `.tsx` component rendered under `bun test`
 * reaches `React.createElement` and never its own body. A source rule is what is left, and it is
 * the one the framework's own `fix:` line names.
 */

import { expect, test } from '@ultimat3/testing';

/** Both surfaces: `site/` renders on the server too, and inherits exactly the same failure. */
const SURFACES = 'apps/web/{app,site}/**/*.tsx';

// `Bun.fileURLToPath`, never `.pathname`: a file URL percent-encodes, so a checkout under a
// directory with a space in it hands `Bun.Glob.scan` an ENOENT naming a path nobody typed.
const APP_ROOT = Bun.fileURLToPath(new URL('../../../', import.meta.url));

/**
 * Transpiled, never the raw text: comments are the file's argument ABOUT the rule — this one's
 * header names `<UiProvider>` in prose — and a scanner over raw text would report the explanation
 * as the violation. Bun's transpiler is the parser the boundary checks already use.
 */
const transpiler = new Bun.Transpiler({ loader: 'tsx' });

const offenders = async (): Promise<readonly string[]> => {
  const found: string[] = [];
  for await (const path of new Bun.Glob(SURFACES).scan({ cwd: APP_ROOT })) {
    if (path.endsWith('.island.tsx')) continue;
    const code = transpiler.transformSync(await Bun.file(`${APP_ROOT}${path}`).text());
    if (code.includes('UiProvider')) found.push(path);
  }
  return found.sort();
};

test('no server-rendered module names UiProvider — only a *.island.tsx may', async () => {
  expect(await offenders()).toEqual([]);
});

/** A rule whose glob matches nothing passes for the wrong reason. */
test('the scan reaches this app’s server-rendered modules at all', async () => {
  const scanned: string[] = [];
  for await (const path of new Bun.Glob(SURFACES).scan({ cwd: APP_ROOT })) scanned.push(path);
  expect(scanned).toContain('apps/web/app/layout.tsx');
});
