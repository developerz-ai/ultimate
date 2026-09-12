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
import { EXECUTABLE_FILES } from './scaffold-docs';
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

describe('unit · the tsconfig.json x new writes', () => {
  // `x verify`'s first step is `tsc -b`, which decides "up to date?" by comparing emitted OUTPUTS
  // against inputs. With `noEmit` and no `composite`, the output it looks for is an
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
  // The scaffold's own `bin/` wrappers are the form that works, and `bin/setup` already used
  // `bunx x` internally for exactly this reason.
  //
  // Narrow on purpose, to the two places a line is COPIED AND RUN rather than read: the executable
  // scripts, and the README block headed "Start". A comment elsewhere saying "then x db gen" is
  // prose about a command, and a rule that reported it would be argued with instead of obeyed.
  const RUNNABLE = /(^|[\s&|;])x\s+[a-z]/;

  const linesOf = (path: string): readonly string[] => emitted(path).split('\n');

  test('no bin/ script invokes a bare `x`', () => {
    const offenders = ['bin/setup', 'bin/dev', 'bin/check'].flatMap((path) =>
      linesOf(path).flatMap((line, index) =>
        RUNNABLE.test(line) && !line.includes('bunx x') && !line.trimStart().startsWith('#')
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
      new URL('../../../../package.json', import.meta.url).pathname,
    ).json()) as { devDependencies?: Record<string, string> };
    const ours = root.devDependencies?.['typescript'];
    expect(ours).toBeDefined();

    // Compared on the MAJOR, not the exact range: the repo may sit on a newer patch than the
    // scaffold names without an app being wrong. A major apart is what breaks type resolution.
    const majorOf = (range: string): string => /(\d+)/.exec(range)?.[1] ?? '';
    expect(majorOf(pinned ?? '')).toBe(majorOf(ours ?? ''));
  });

  test('the line `x new` prints last names a command the author can run', () => {
    const done = msg('cli.new.done', { name: 'ledger-demo' });
    expect(done).toContain('bin/setup');
    expect(RUNNABLE.test(done.replace('bin/setup', ''))).toBe(false);
  });

  // `cmd-new.ts` chmods `EXECUTABLE_FILES` and NOTHING else, so a `bin/` script missing from that
  // list is written 0644 and answers `Permission denied` the first time anyone runs it. Nothing
  // would catch it: the scaffold gate runs `bin/setup` and `bin/check`, so `bin/dev` — the command
  // `cli.new.done` and `README.md` both tell the author to run next — could ship unexecutable
  // through a green gate. Derived from the emitted list rather than naming the three by hand, so
  // a fourth script added tomorrow is covered by the act of emitting it.
  test('every bin/ script x new writes is one cmd-new.ts makes executable', () => {
    const emittedBin = repoFiles(names('ledger-demo'), '1.0.0', true)
      .map((file) => file.path)
      .filter((path) => path.startsWith('bin/'))
      .sort();
    // A filter matching nothing would agree with an empty EXECUTABLE_FILES.
    expect(emittedBin).toContain('bin/dev');
    expect(emittedBin).toEqual([...EXECUTABLE_FILES].sort());
  });
});
