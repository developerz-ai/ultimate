// The public surface `scripts/public-api.ts` hashes: every publishable package's `exports` — the
// main entry, each subpath, each file a `./x/*` family matches — and their declarations, emitted by
// the repo's own `tsc` (`--noCheck`: declarations only, the type errors are `typecheck`'s).

// why: Bun has no recursive mkdir/remove of its own; node:fs/promises is the only way.
import { mkdir, rm } from 'node:fs/promises';
import { localBin } from './local-bin';
import { toPosix } from './posix-path';
import type { DtsTree } from './public-api-symbols';
import { LONG_RUN_TIMEOUT_MS, run } from './run';

export interface ApiPackage {
  readonly name: string;
  readonly dir: string;
}

export interface ApiEntry {
  /** `@ultimat3/core`, `@ultimat3/core/outbound`, `@ultimat3/ui/icons/x`. */
  readonly specifier: string;
  /** Repo-relative source, `packages/core/src/outbound-subpath.ts`. */
  readonly source: string;
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const TS_FILE = /\.tsx?$/;

/** One package's entries, read from its `package.json` `exports` (a string is the main entry). */
export async function packageEntries(root: string, pkg: ApiPackage): Promise<readonly ApiEntry[]> {
  const manifest: unknown = await Bun.file(`${root}/packages/${pkg.dir}/package.json`).json();
  const raw = isRecord(manifest) ? manifest['exports'] : undefined;
  const exports: Readonly<Record<string, unknown>> = typeof raw === 'string' ? { '.': raw } : {};
  const table = isRecord(raw) ? raw : exports;
  const entries: ApiEntry[] = [];
  for (const [key, value] of Object.entries(table)) {
    if (typeof value !== 'string' || !TS_FILE.test(value)) continue;
    const target = value.replace(/^\.\//, '');
    const specifier = key === '.' ? pkg.name : `${pkg.name}${key.slice(1)}`;
    if (!key.includes('*')) {
      entries.push({ specifier, source: `packages/${pkg.dir}/${target}` });
      continue;
    }
    // A family: each file the target pattern matches is an entry of its own.
    const [head = '', tail = ''] = target.split('*');
    const glob = new Bun.Glob(target);
    for await (const hit of glob.scan({ cwd: `${root}/packages/${pkg.dir}` })) {
      const file = toPosix(hit);
      const stem = file.slice(head.length, file.length - tail.length);
      // An exports key holds one `*` (Node's rule); replaceAll leaves none behind either way.
      entries.push({
        specifier: specifier.replaceAll('*', stem),
        source: `packages/${pkg.dir}/${file}`,
      });
    }
  }
  return entries.sort((a, b) => (a.specifier < b.specifier ? -1 : 1));
}

/** Where `tsc` writes `packages/<dir>/src/x.ts`'s declaration, relative to the out dir. */
export const dtsPathOf = (source: string): string =>
  source.replace(/^packages\//, '').replace(TS_FILE, '.d.ts');

export type EmitResult =
  | { readonly ok: true; readonly tree: DtsTree }
  | { readonly ok: false; readonly problem: string };

/** Emit every entry's declarations into a per-process scratch dir, read them, remove the dir. */
export async function emitDeclarations(
  root: string,
  entries: readonly ApiEntry[],
  tsc: string = localBin(root, 'tsc'),
): Promise<EmitResult> {
  const base = toPosix(root);
  // Per process AND per tree: a release tag's tree shares this one's `node_modules` (a junction).
  const scratch = `${base}/node_modules/.cache/ultimate-public-api-${process.pid}-${Bun.hash(base).toString(36)}`;
  await rm(scratch, { recursive: true, force: true });
  await mkdir(scratch, { recursive: true });
  try {
    const config = {
      extends: `${base}/tsconfig.base.json`,
      compilerOptions: {
        composite: false,
        incremental: false,
        declaration: true,
        declarationMap: false,
        sourceMap: false,
        emitDeclarationOnly: true,
        noCheck: true,
        rootDir: `${base}/packages`,
        outDir: `${scratch}/out`,
      },
      files: entries.map((entry) => `${base}/${entry.source}`),
    };
    await Bun.write(`${scratch}/tsconfig.json`, JSON.stringify(config));
    const result = await run([tsc, '-p', `${scratch}/tsconfig.json`], {
      cwd: root,
      timeoutMs: LONG_RUN_TIMEOUT_MS,
    });
    const files = new Map<string, string>();
    for await (const hit of new Bun.Glob('**/*.d.ts').scan({ cwd: `${scratch}/out` })) {
      const path = toPosix(hit);
      files.set(path, await Bun.file(`${scratch}/out/${path}`).text());
    }
    const missing = entries.filter((entry) => !files.has(dtsPathOf(entry.source)));
    if (missing.length > 0) {
      const first = missing[0]?.source ?? '';
      return {
        ok: false,
        problem: `tsc emitted no declaration for ${missing.length} entr${missing.length === 1 ? 'y' : 'ies'} (first: ${first}): ${result.output.slice(0, 300)}`,
      };
    }
    const specifiers = new Map(entries.map((entry) => [entry.specifier, dtsPathOf(entry.source)]));
    return { ok: true, tree: { files, specifiers } };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
