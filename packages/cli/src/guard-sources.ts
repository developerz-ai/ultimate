// One read of the app per gate run, shared by every guard. Every guard `SHIPPED_GUARD_NAMES` lists
// (`templates/scaffold-guards.ts`), each walking the tree and re-reading every stylesheet, is one
// walk per guard for one answer, and two guards compiling the same module is Sass run twice — so
// the runner hands each `check` these, memoised for the run.

// why: `join` builds the host-separator path a glob entry is read at; Bun ships no path API.
import { join } from 'node:path';
import { renderThrowable, stringField } from '@ultimat3/core';

export interface GuardFile {
  /** App-root-relative POSIX path, so a finding names the file an author opens. */
  readonly path: string;
  readonly text: string;
}

/** A stylesheet as the build compiles it. */
export interface GuardStylesheet {
  readonly css: string;
  /** `hero` → its scoped name. Empty for a sheet that is not a `.module.scss`. */
  readonly classes: Readonly<Record<string, string>>;
}

export interface GuardSources {
  /**
   * Every file under the app root matching `glob`, sorted. Dependencies, build output and caches
   * are never the app, so they are never returned. Asked twice, walked once.
   */
  files(glob: string): Promise<readonly GuardFile[]>;
  /**
   * The stylesheet at an app-root-relative path, compiled by the compiler the build uses.
   * `undefined` when the file is absent or does not compile: that refusal is the build's
   * (`X_PRERENDER_FAILED`, with the Sass error), never a guard's to repeat.
   */
  compiled(path: string): Promise<GuardStylesheet | undefined>;
  /**
   * Why `compiled(path)` is `undefined`: the compiler's (or the read's) first line, so a guard
   * that reports a broken sheet names the error. `undefined` when the sheet compiles. Optional
   * so a `GuardSources` an app built itself, before this existed, still satisfies the type.
   */
  compileError?(path: string): Promise<string | undefined>;
}

/** Path segments that are never the app's own source. */
const NOT_SOURCE = /(?:^|\/)(?:node_modules|dist|\.x|\.git)\//;

/**
 * `seed` is text the gate step ALREADY read — the `boundaries` step reads every surface file for
 * its own import rules before any guard runs, and a guard that walks `apps/**` would read each of
 * them a second time. Seeded, a path is read at most once per step; anything the seed does not
 * hold (a stylesheet, a test, a package) is read here on first ask, as before.
 */
export function guardSources(
  root: string,
  seed: readonly { readonly path: string; readonly source: string }[] = [],
): GuardSources {
  const texts = new Map<string, Promise<string>>();
  for (const file of seed) texts.set(file.path, Promise.resolve(file.source));
  const walks = new Map<string, Promise<readonly GuardFile[]>>();
  const sheets = new Map<string, Promise<GuardStylesheet | string>>();

  const textOf = (path: string): Promise<string> => {
    let text = texts.get(path);
    if (text === undefined) {
      text = Bun.file(join(root, path)).text();
      texts.set(path, text);
    }
    return text;
  };

  const walk = async (glob: string): Promise<readonly GuardFile[]> => {
    const paths: string[] = [];
    for await (const entry of new Bun.Glob(glob).scan({ cwd: root, absolute: false })) {
      const path = entry.split('\\').join('/');
      if (!NOT_SOURCE.test(path)) paths.push(path);
    }
    paths.sort();
    return Promise.all(paths.map(async (path) => ({ path, text: await textOf(path) })));
  };

  /** The sheet, or the first line of why it is not one. */
  const compile = async (path: string): Promise<GuardStylesheet | string> => {
    try {
      const source = await textOf(path);
      // Imported here, not at the top: Sass loads on the first compile, and a gate run whose
      // guards compile nothing must not pay for the compiler (`sass-lazy.test.ts`).
      const { compileStylesheet } = await import('@ultimat3/render/server');
      const { css, classes } = compileStylesheet(join(root, path), source);
      return { css, classes };
    } catch (error) {
      // The compiler's own words: render's `X_PRERENDER_FAILED` carries them in its cause behind
      // the absolute path, which names a temp root in a test and a different checkout in CI.
      const absolute = join(root, path);
      const said = (stringField(error, 'cause') ?? renderThrowable(error)).split('\n')[0] ?? '';
      return said.replace(`${absolute} did not compile: `, '').replaceAll(absolute, path);
    }
  };

  const compiledOnce = (path: string): Promise<GuardStylesheet | string> => {
    let sheet = sheets.get(path);
    if (sheet === undefined) {
      sheet = compile(path);
      sheets.set(path, sheet);
    }
    return sheet;
  };

  return {
    files(glob) {
      let found = walks.get(glob);
      if (found === undefined) {
        found = walk(glob);
        walks.set(glob, found);
      }
      return found;
    },
    async compiled(path) {
      const sheet = await compiledOnce(path);
      return typeof sheet === 'string' ? undefined : sheet;
    },
    async compileError(path) {
      const sheet = await compiledOnce(path);
      return typeof sheet === 'string' ? sheet : undefined;
    },
  };
}
