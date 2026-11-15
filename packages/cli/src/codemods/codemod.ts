// The codemod contract: a template change an app keeps, carried across by a pure function over an
// app it can read and write but never touch directly — so the engine can dry-run, report and diff.
// Every migration is one `codemods/<id>.ts` exporting `const codemod: Codemod`; `index.ts` lists them.

/** The app a codemod sees. Paths are app-root relative, posix separators. */
export interface CodemodApp {
  readonly root: string;
  read(path: string): Promise<string | undefined>;
  write(path: string, source: string): Promise<void>;
  remove(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  glob(pattern: string): Promise<readonly string[]>;
}

/** A file a codemod would not overwrite (app-edited, unrecognised), with the change it wanted. */
export interface CodemodSkip {
  readonly path: string;
  readonly reason: string;
  readonly diff?: string;
}

export interface CodemodResult {
  readonly changed: string[];
  readonly skipped: CodemodSkip[];
}

export interface Codemod {
  readonly id: string;
  /** The framework version whose template change this carries an app across. */
  readonly since: string;
  readonly summary: string;
  run(app: CodemodApp): Promise<CodemodResult>;
}

/** An in-memory `CodemodApp` for tests: `files` is the app, mutated in place. */
export function memoryCodemodApp(
  files: Record<string, string>,
  root = '/app',
): CodemodApp & { readonly files: Record<string, string> } {
  return {
    root,
    files,
    read: async (path) => (Object.hasOwn(files, path) ? files[path] : undefined),
    write: async (path, source) => {
      files[path] = source;
    },
    remove: async (path) => {
      delete files[path];
    },
    exists: async (path) => Object.hasOwn(files, path),
    glob: async (pattern) => {
      const glob = new Bun.Glob(pattern);
      return Object.keys(files)
        .filter((path) => glob.match(path))
        .sort();
    },
  };
}
