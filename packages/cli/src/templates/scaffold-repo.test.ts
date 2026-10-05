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
import { msg } from '../messages';
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

describe('unit · the biome.json x new writes · Bun-only rules', () => {
  // A bare `'fs'` reaches the same builtin as `'node:fs'`, and Biome reports the bare spelling at
  // `info` by default — exit 0, a rule nobody is asked to read. The framework's own config makes it
  // an error; an app inherits the same convention on day one. Asserted on the PARSED config.
  test('a bare Node builtin specifier is a lint error, not an info line', () => {
    const config = JSON.parse(emitted('biome.json')) as {
      readonly linter?: { readonly rules?: { readonly style?: Readonly<Record<string, unknown>> } };
    };
    expect(config.linter?.rules?.style?.['useNodejsImportProtocol']).toBe('error');
  });
});

describe('unit · the tsconfig.json x new writes', () => {
  // `tsc -b` decided "up to date?" by comparing emitted OUTPUTS against inputs. With `noEmit` and no `composite`, the output it looks for is an
  // `app.config.js` that will never exist, so a scaffolded app re-typechecked from scratch on
  // every single run — 92s wall / 43s user CPU on 166 files with no change between runs, against
  // 4.9s / 8.8s warm with this one line. Asserted on the PARSED config, not on the text, so a
  // reformat of the template cannot make the assertion pass while the flag is gone.
  test('it opts into incremental typechecking, which tsc -b cannot do without', () => {
    const config = JSON.parse(emitted('tsconfig.json')) as {
      readonly compilerOptions?: Readonly<Record<string, unknown>>;
    };
    // Bracketed: `compilerOptions` is an index signature, and `noPropertyAccessFromIndexSignature`
    // makes the dotted read TS4111.
    expect(config.compilerOptions?.['incremental']).toBe(true);
  });

  // #450: `tsc -b` trusts mtimes, and a Bun hardlinked install hands a changed dependency an old
  // one. The scaffold's own script runs the content-hashed form the gate's step runs.
  test('its typecheck script is tsc -p ., never the mtime-trusting tsc -b', () => {
    const manifest = JSON.parse(emitted('package.json')) as {
      readonly scripts?: Readonly<Record<string, string>>;
    };
    expect(manifest.scripts?.['typecheck']).toBe('tsc -p . --pretty');
  });

  // A bare `bun test` runs every file in ONE process, where a module-scope registration from one
  // file (the admin app's routes) is visible to another's contract test, and the demo app went
  // red six tests at a time under a script the gate never runs. `--isolate` gives each file its own
  // globals, which is what the gate's per-type runs already amount to.
  test('its test script isolates each file, as the gate does', () => {
    const manifest = JSON.parse(emitted('package.json')) as {
      readonly scripts?: Readonly<Record<string, string>>;
    };
    expect(manifest.scripts?.['test']).toBe('bun test --isolate');
  });

  // The buildinfo `incremental` writes has to be ignored, or the first `git status` after a
  // typecheck shows a file nobody wrote.
  // `x dev`'s ignore set IS this file (`dev-watch.ts`), so an unanchored build-output rule costs
  // the app a route: `coverage/` matches `apps/web/site/coverage/` too, and the directory is the
  // URL. Reproduced against the watcher: the page never reloaded and nothing said why.
  test('build output is root-anchored, so it cannot swallow a route of the same name', () => {
    const emittedGitignore = emitted('.gitignore');
    expect(emittedGitignore).toContain('/dist/');
    expect(emittedGitignore).toContain('/coverage/');
    expect(emittedGitignore.split('\n')).not.toContain('dist/');
    expect(emittedGitignore.split('\n')).not.toContain('coverage/');
    // And a workspace's own build output is still ignored, by a pattern that names where it is.
    expect(emittedGitignore).toContain('packages/*/dist/');
  });

  test('.gitignore covers the buildinfo the flag produces', () => {
    expect(emitted('.gitignore')).toContain('*.tsbuildinfo');
  });
});

describe('unit · the bunfig.toml x new writes', () => {
  /**
   * `bun test --coverage` in a scaffolded app reported a two-line minified `.mjs` in the system
   * temp directory: the BUILT island chunk `@ultimat3/testing`'s `mountIsland` imports. Bun does
   * not remap a pre-built module through its sourcemap — measured on 1.4.0, and
   * `island-bundle.ts` does emit one — so the row names a file no author has and the island's own
   * `.island.tsx` never appears. Only the noise is fixed here; a `mountIslandSource` lane is a
   * separate change.
   *
   * Asserted on the PARSED config: a reformat of the template must not be able to make this pass
   * while the key is gone, and a comment mentioning the pattern must not be able to either.
   */
  test('coverage ignores the built island chunk a mount imports', () => {
    const config = Bun.TOML.parse(emitted('bunfig.toml')) as {
      readonly test?: Readonly<Record<string, unknown>>;
    };
    expect(config.test?.['coveragePathIgnorePatterns']).toEqual(['**/*.mjs']);
  });

  // The key is worthless if the file it sits in is not the one Bun reads, and the preload it
  // shares the section with is what makes every scaffolded test deterministic.
  test('it is the [test] section Bun reads, with the preload still in it', () => {
    const config = Bun.TOML.parse(emitted('bunfig.toml')) as {
      readonly test?: Readonly<Record<string, unknown>>;
    };
    expect(config.test?.['preload']).toEqual(['@ultimat3/testing/preload']);
  });
});

describe('unit · the first commands a scaffold tells its author to run exist on PATH', () => {
  // `bun install` links the `x` binary into `./node_modules/.bin` and nowhere else, so a bare
  // `x dev` pasted into a shell is `command not found` — proved with `env -i PATH=… command -v x`.
  // `bun run <script>` is the form that works — Bun puts that directory on PATH for the script —
  // and the `bin/*.ts` files spawn `bun x x` (bunx) for exactly this reason.
  //
  // Narrow on purpose, to the two places a line is COPIED AND RUN rather than read: the executable
  // scripts, and the README block headed "Start". A comment elsewhere saying "then x db gen" is
  // prose about a command, and a rule that reported it would be argued with instead of obeyed.
  const RUNNABLE = /(^|[\s&|;])x\s+[a-z]/;

  const linesOf = (path: string): readonly string[] => emitted(path).split('\n');

  test('no bin/ script invokes a bare `x`', () => {
    const offenders = ['bin/setup.ts', 'bin/check.ts'].flatMap((path) =>
      linesOf(path).flatMap((line, index) =>
        RUNNABLE.test(line) && !line.includes('bunx x') && !line.trimStart().startsWith('//')
          ? [`${path}:${index + 1}`]
          : [],
      ),
    );
    expect(offenders).toEqual([]);
  });

  test("the README's Start block runs only commands a fresh shell has", () => {
    const lines = linesOf('README.md');
    const open = lines.findIndex((line) => line.startsWith('```sh'));
    const close = lines.findIndex((line, index) => index > open && line.startsWith('```'));
    expect(open).toBeGreaterThan(-1);
    const block = lines.slice(open + 1, close);
    expect(block.length).toBeGreaterThan(0);
    expect(block.filter((line) => RUNNABLE.test(line) && !line.includes('bunx x'))).toEqual([]);
  });

  test('the scaffold typechecks with the compiler the framework itself is gated on', async () => {
    // The drift this catches is silent and one-directional: the framework bumps TypeScript, its
    // packages ship `.d.ts` emitted by the new compiler, and `x new` keeps handing apps an older
    // one that reads them. Measured 2026-09-08: the repo was on 7.0.2 and the scaffold pinned
    // `^6.0.3` — a whole major behind, through no failing check. Biome's pin never drifted because
    // it is spelled once as a constant; TypeScript's was a literal in a dependency block.
    const scaffold = repoFiles(names('ledger-demo'), '1.0.0', true).find(
      (file) => file.path === 'package.json',
    );
    expect(scaffold).toBeDefined();
    // `contents` is `string | Uint8Array` — a scaffold writes binary files too (the icon) — so the
    // narrow is the assertion: a `package.json` that arrived as bytes is a different defect.
    const contents = scaffold?.contents;
    expect(typeof contents).toBe('string');
    const scaffolded = JSON.parse(typeof contents === 'string' ? contents : '{}') as {
      devDependencies?: Record<string, string>;
    };
    const pinned = scaffolded.devDependencies?.['typescript'];
    expect(pinned).toBeDefined();

    const root = (await Bun.file(
      Bun.fileURLToPath(new URL('../../../../package.json', import.meta.url)),
    ).json()) as { devDependencies?: Record<string, string> };
    const ours = root.devDependencies?.['typescript'];
    expect(ours).toBeDefined();

    // Compared on the MAJOR, not the exact range: the repo may sit on a newer patch than the
    // scaffold names without an app being wrong. A major apart is what breaks type resolution.
    const majorOf = (range: string): string => /(\d+)/.exec(range)?.[1] ?? '';
    expect(majorOf(pinned ?? '')).toBe(majorOf(ours ?? ''));
  });

  // The scaffold pinned `solid-js` 1.9.14 while this repository ran 1.9.15 and the CLI's own
  // `babel-preset-solid ^1.9.15` compiles every island against it: a literal in a dependency block
  // drifts with no failing check, so it is a constant held to the root manifest here.
  test('the scaffold pins the solid-js this repository itself runs', async () => {
    const scaffolded = JSON.parse(emitted('package.json')) as {
      dependencies?: Record<string, string>;
    };
    const root = (await Bun.file(
      Bun.fileURLToPath(new URL('../../../../package.json', import.meta.url)),
    ).json()) as { devDependencies?: Record<string, string> };
    expect(root.devDependencies?.['solid-js']).toMatch(/^\d+\.\d+\.\d+$/);
    expect(scaffolded.dependencies?.['solid-js']).toBe(root.devDependencies?.['solid-js'] ?? '');
  });

  test('the scaffold lints with the Biome this repository itself runs', async () => {
    // Exact, where the TypeScript pin above compares majors: a formatter is a build input, and a
    // patch apart is already visible — the repo sat on 2.5.5 under a `^2.4.15` range while the
    // scaffold pinned 2.5.8, so every lint of a scaffolded app from inside this repo printed a
    // schema-mismatch block, and `emitted-contract.test.ts` held templates to a formatter one
    // patch away from the one their app installs.
    const scaffold = repoFiles(names('ledger-demo'), '1.0.0', true);
    const textOf = (path: string): string => {
      const contents = scaffold.find((file) => file.path === path)?.contents;
      return typeof contents === 'string' ? contents : '';
    };
    const pinned = (
      JSON.parse(textOf('package.json')) as { devDependencies?: Record<string, string> }
    ).devDependencies?.['@biomejs/biome'];
    expect(pinned).toMatch(/^\d+\.\d+\.\d+$/);

    const rootFile = (name: string): Promise<unknown> =>
      Bun.file(new URL(`../../../../${name}`, import.meta.url)).json();
    const root = (await rootFile('package.json')) as { devDependencies?: Record<string, string> };
    expect(root.devDependencies?.['@biomejs/biome']).toBe(pinned ?? '');

    // And each `$schema` names the version beside it — the mismatch Biome itself reports.
    const schemaOf = (config: unknown): string =>
      String((config as { $schema?: unknown }).$schema ?? '');
    const expected = `https://biomejs.dev/schemas/${pinned ?? ''}/schema.json`;
    expect(schemaOf(await rootFile('biome.json'))).toBe(expected);
    expect(schemaOf(JSON.parse(textOf('biome.json')))).toBe(expected);

    // The two tracked apps are workspaces of this repository, so a range one of them declares is
    // one more answer to "which Biome lints this tree" — `dummy/social-media-clone` said `^2.4.15`
    // beside the root's exact pin. An app that declares none, or carries no `biome.json` of its
    // own, inherits the root's: it has no second answer to hold.
    for (const app of ['examples/dummy', 'dummy/social-media-clone']) {
      const manifest = (await rootFile(`${app}/package.json`)) as {
        devDependencies?: Record<string, string>;
      };
      const declared = manifest.devDependencies?.['@biomejs/biome'];
      expect({ app, declared: declared ?? pinned }).toEqual({ app, declared: pinned });
      const config = Bun.fileURLToPath(new URL(`../../../../${app}/biome.json`, import.meta.url));
      const schema = (await Bun.file(config).exists())
        ? schemaOf(await Bun.file(config).json())
        : expected;
      expect({ app, schema }).toEqual({ app, schema: expected });
    }
  });

  test('the line `x new` prints last names a command the author can run', () => {
    const done = msg('cli.new.done', { name: 'ledger-demo', cd: 'ledger-demo' });
    expect(done).toContain('bun run setup');
    expect(RUNNABLE.test(done)).toBe(false);
  });

  // A `bin/` file no `package.json` script runs is a second, undocumented way in; a script naming
  // a file `x new` never wrote answers "Module not found" on the first command a newcomer types.
  // Derived from the emitted list, so a third script added tomorrow is covered by emitting it.
  test('every bin/ file x new writes is what a package.json script runs, and nothing else', () => {
    const emittedBin = repoFiles(names('ledger-demo'), '1.0.0', true)
      .map((file) => file.path)
      .filter((path) => path.startsWith('bin/'))
      .sort();
    // A filter matching nothing would agree with a package.json naming no file.
    expect(emittedBin).toContain('bin/setup.ts');
    const scripts =
      (JSON.parse(emitted('package.json')) as { scripts?: Record<string, string> }).scripts ?? {};
    const run = Object.values(scripts)
      .flatMap((line) => /^bun (bin\/\S+\.ts)$/.exec(line)?.[1] ?? [])
      .sort();
    expect(run).toEqual(emittedBin);
    expect(scripts['dev']).toBe('x dev');
  });

  // Git for Windows checks out CRLF by default; the root `.gitattributes` is what keeps a Windows
  // clone byte-identical to the one CI gates. Its contents are `scaffold-gitattributes.test.ts`'s.
  test('x new writes the root .gitattributes', () => {
    expect(emitted('.gitattributes')).toContain('* text=auto eol=lf');
  });
});
