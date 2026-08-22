// The tooling configs `x new` writes, held to the one rule a config has: it must not put the app's
// own gate in a loop it cannot leave.
//
// The `biome.json` that shipped excluded `migrations`, `x.manifest.json` and `openapi.json` and NOT
// `.x`. `x build` writes minified island bundles to `.x/static/islands/`, `lint` then reported ~175
// `noCommaOperator`/`noAssignInExpressions` errors in Bun's own output, and the `fix:` for that
// step — `biome check --write .` — exits 1 on them, so a pristine scaffold went red forever the
// moment it followed the `budgets` step's own printed fix. `--unsafe` was worse: it rewrote a
// content-hashed chunk in place, 55,499 → 83,605 bytes, so the artifact's name stopped matching
// its bytes. `x new --no-example` hid all of it, which is why `scaffold-smoke` was green.

import { describe, expect, test } from 'bun:test';
import { names } from './naming';
import { repoFiles } from './scaffold-repo';

interface BiomeConfig {
  readonly vcs?: Readonly<Record<string, unknown>>;
  readonly files?: { readonly includes?: readonly string[] };
}

const emitted = (path: string): string => {
  const file = repoFiles(names('ledger-demo'), '1.0.0', true).find((entry) => entry.path === path);
  if (file === undefined) return expect.unreachable(`x new writes no ${path}`);
  return typeof file.contents === 'string'
    ? file.contents
    : expect.unreachable(`${path} is bytes, not text`);
};

const biome = (): BiomeConfig => JSON.parse(emitted('biome.json')) as BiomeConfig;

describe('unit · the biome.json x new writes', () => {
  // Every directory the framework's own tooling GENERATES into. A formatter that rewrites a
  // generated artifact is a `lint` step and a generator that cannot both be satisfied.
  test('it lints no directory the build writes into', () => {
    const includes = biome().files?.includes ?? [];
    for (const generated of ['!**/.x', '!**/dist', '!**/.output', '!**/migrations']) {
      expect(`biome.json excludes ${generated}: ${String(includes.includes(generated))}`).toBe(
        `biome.json excludes ${generated}: true`,
      );
    }
  });

  // The second half, and not a duplicate of the first: it makes the next generated directory the
  // app adds to `.gitignore` excluded by the act of ignoring it. It needs `.gitignore` to EXIST —
  // Biome exits 1 with `couldn't find an ignore file` otherwise — so the two are asserted together.
  test('it reads .gitignore, and x new writes one for it to read', () => {
    expect(biome().vcs).toEqual({ enabled: true, clientKind: 'git', useIgnoreFile: true });
    expect(emitted('.gitignore')).toContain('.x/');
  });

  // Biome's own parser rejects a `//` comment in its config, which made every scaffolded app fail
  // its first `x verify` on the config rather than on the code. Matched on a comment LINE, not on
  // the substring: `"$schema": "https://…"` carries `//` and is not a comment.
  test('the config is valid JSON with no comment line in it — Biome parses it strictly', () => {
    const lines = emitted('biome.json').split('\n');
    expect(lines.filter((line) => line.trimStart().startsWith('//'))).toEqual([]);
    expect(() => JSON.parse(emitted('biome.json')) as unknown).not.toThrow();
  });
});
