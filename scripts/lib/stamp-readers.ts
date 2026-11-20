// Which CLI modules read the stamped version where a test reaches them, and which test files import
// one: the release rehearsal's selection beyond the directories it names. The 31.49.0 release PR
// redded on `doctor-warnings.test.ts`, which no rehearsal ran: `cmd-doctor.ts` read `cliVersion()`.

// why: Bun ships no path normaliser; a relative import is resolved against its file's directory.
import { posix } from 'node:path';

export interface SourceFile {
  readonly path: string;
  readonly text: string;
}

/** A call of either stamp reader; its own definition (`export function cliVersion`) is not one. */
const READS_STAMP = /(?<!function )\b(?:cliVersion|loadVersion)\(\)/;

/** The non-test modules that call `cliVersion()` / `loadVersion()`, repository-relative. */
export const stampReaders = (sources: readonly SourceFile[]): readonly string[] =>
  sources
    .filter((file) => !file.path.endsWith('.test.ts') && READS_STAMP.test(file.text))
    .map((file) => file.path)
    .sort();

const transpilers = {
  ts: new Bun.Transpiler({ loader: 'ts' }),
  tsx: new Bun.Transpiler({ loader: 'tsx' }),
};

/**
 * A file's relative value imports, as the repository paths each could resolve to: an
 * extension-less specifier is a file (`.ts`, `.tsx`) or a directory's `index.ts` — `./templates`
 * read as `templates.ts` alone missed a test importing a reader through its directory.
 */
export function relativeImports(file: SourceFile): readonly string[] {
  const transpiler = file.path.endsWith('.tsx') ? transpilers.tsx : transpilers.ts;
  const dir = posix.dirname(file.path);
  return transpiler
    .scanImports(file.text)
    .filter((entry) => entry.path.startsWith('.'))
    .map((entry) => posix.join(dir, entry.path))
    .flatMap((path) =>
      /\.tsx?$/.test(path) ? [path] : [`${path}.ts`, `${path}.tsx`, `${path}/index.ts`],
    );
}

/** True when the test imports a stamp reader directly: what it asserts can carry the stamp. */
export const importsStampReader = (test: SourceFile, readers: ReadonlySet<string>): boolean =>
  relativeImports(test).some((path) => readers.has(path));
