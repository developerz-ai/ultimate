// The template tree a ref held, extracted with every module outside `templates/` its graph imports
// at run time — the closure, derived from the extracted source and never a hardcoded list — so a
// tag's `scaffold-guards.ts` loads wherever its imports reach. A ref git cannot archive is coded.

// why: Bun ships no recursive copy, existence check or temp directory; posix paths are git's.
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { quoteArg } from '../../packages/cli/src/shell-quote';
import { ScriptError } from './script-error';

export const TEMPLATES = 'packages/cli/src/templates';

/**
 * Where a ref's tree is extracted: under the CLI's own `node_modules`, so a module the closure
 * reaches resolves `@ultimat3/*` from the workspace links exactly as the CLI does.
 */
export const SCRATCH = 'packages/cli/node_modules/.cache/guard-released-forms';
const CODE = 'X_GUARD_FORMS_ARCHIVE_FAILED';

/** A tree to extract from: a git ref, or the working tree standing in for the next tag. */
export interface TreeSource {
  readonly ref: string;
  /** Writes these repo paths (files or directories) under `dir`; a `ScriptError` when it cannot. */
  extract(paths: readonly string[], dir: string): void;
  /** Which of `candidates` this tree holds: one question per round, never one per import. */
  present(candidates: readonly string[]): ReadonlySet<string>;
}

const failed = (ref: string, cause: string): ScriptError =>
  new ScriptError({
    code: CODE,
    cause: `${ref} could not be extracted for the released guard forms: ${cause}`,
    fix: `git fetch --no-tags origin ${quoteArg(`+refs/tags/${ref}:refs/tags/${ref}`)} && bun run scripts/lib/guard-refresh-forms.ts --write`,
  });

const firstLine = (bytes: Uint8Array): string =>
  new TextDecoder().decode(bytes).split('\n')[0] ?? '';

export function gitTreeSource(root: string, ref: string): TreeSource {
  return {
    ref,
    extract(paths, dir) {
      const archive = Bun.spawnSync(['git', 'archive', ref, '--', ...paths], { cwd: root });
      if (archive.exitCode !== 0) {
        throw failed(
          ref,
          `git archive exited ${String(archive.exitCode)}: ${firstLine(archive.stderr)}`,
        );
      }
      const tar = Bun.spawnSync(['tar', '-x', '-C', dir], { stdin: archive.stdout });
      if (tar.exitCode !== 0) {
        throw failed(ref, `tar exited ${String(tar.exitCode)}: ${firstLine(tar.stderr)}`);
      }
    },
    present(candidates) {
      const listed = Bun.spawnSync(['git', 'ls-tree', '--name-only', ref, '--', ...candidates], {
        cwd: root,
      });
      if (listed.exitCode !== 0) {
        throw failed(
          ref,
          `git ls-tree exited ${String(listed.exitCode)}: ${firstLine(listed.stderr)}`,
        );
      }
      return new Set(new TextDecoder().decode(listed.stdout).split('\n'));
    },
  };
}

/** The working tree, as the tag the next release will cut: what `--write` reads after its own forms. */
export function worktreeSource(root: string): TreeSource {
  return {
    ref: 'the working tree',
    extract(paths, dir) {
      for (const path of paths) cpSync(join(root, path), join(dir, path), { recursive: true });
    },
    present: (candidates) =>
      new Set(candidates.filter((candidate) => existsSync(join(root, candidate)))),
  };
}

/**
 * Bun's own import scanner, never a regex: a template holds generated source in strings, whose
 * `import … from '../…'` lines are text, and `import type` is erased before anything runs.
 */
const SCANNERS = {
  ts: new Bun.Transpiler({ loader: 'ts' }),
  tsx: new Bun.Transpiler({ loader: 'tsx' }),
};

const candidatesOf = (base: string): readonly string[] => [
  `${base}.ts`,
  `${base}.tsx`,
  `${base}/index.ts`,
  base,
];

/** A file's relative runtime imports, as the extension-less repo paths they name. */
const relativeImports = (path: string, text: string): readonly string[] => {
  const scanner = path.endsWith('.tsx') ? SCANNERS.tsx : SCANNERS.ts;
  return scanner
    .scanImports(text)
    .map(({ path: spec }) => spec)
    .filter((spec) => spec.startsWith('./') || spec.startsWith('../'))
    .map((spec) => posix.join(posix.dirname(path), spec).replace(/\.(?:tsx?|js)$/, ''));
};

/**
 * Pure: every relative runtime import in `files` (repo path → text) that none of them satisfies,
 * as the extension-less repo path it names. Sorted, so a run is reproducible.
 */
export function outsideImports(files: ReadonlyMap<string, string>): readonly string[] {
  const missing = new Set<string>();
  for (const [path, text] of files) {
    for (const base of relativeImports(path, text)) {
      if (!candidatesOf(base).some((candidate) => files.has(candidate))) missing.add(base);
    }
  }
  return [...missing].sort();
}

/** The repo paths `entry`'s graph reaches through relative imports, read from under `dir`. */
const reachable = async (dir: string, entry: string): Promise<Map<string, string>> => {
  const files = new Map<string, string>();
  const stack = [entry];
  while (stack.length > 0) {
    const path = stack.pop() ?? '';
    if (files.has(path)) continue;
    const file = Bun.file(join(dir, path));
    if (!(await file.exists())) continue;
    const text = await file.text();
    files.set(path, text);
    for (const base of relativeImports(path, text)) {
      for (const candidate of candidatesOf(base)) stack.push(candidate);
    }
  }
  return files;
};

/** The guard list a tag's templates load from. */
export const ENTRY = `${TEMPLATES}/scaffold-guards.ts`;

/** `templates/` plus what `ENTRY`'s graph imports outside it, under `dir` at repo paths. */
export async function extractTemplates(source: TreeSource, dir: string): Promise<void> {
  source.extract([TEMPLATES], dir);
  const tried = new Set<string>();
  for (;;) {
    const next = outsideImports(await reachable(dir, ENTRY)).filter((base) => !tried.has(base));
    if (next.length === 0) return;
    const held = source.present(next.flatMap(candidatesOf));
    const found: string[] = [];
    for (const base of next) {
      tried.add(base);
      const file = candidatesOf(base).find((candidate) => held.has(candidate));
      if (file === undefined) {
        throw failed(source.ref, `a template imports ${base}, which this tree does not hold`);
      }
      found.push(file);
    }
    for (const file of found) mkdirSync(dirname(join(dir, file)), { recursive: true });
    source.extract(found, dir);
  }
}
