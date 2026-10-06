// One module, one copy per island chunk — read off the build's metafile. Bun keys a module by its
// path STRING, so one file reached under two spellings ships twice: a drive letter in two cases, `\`
// beside `/`, a junction beside its target. Measured on the windows job, the scaffold's `/posts`
// island shipped 81,306 B against Linux's 59,849 B from the same source, with `success: true`.

// why: Bun ships no path API and no realpath; `win32`/`posix` let a Windows-shaped metafile be
// judged on any host, and `realpathSync` folds a link into the file it names.
import { realpathSync } from 'node:fs';
import { posix, win32 } from 'node:path';

/** The part of `Bun.BuildMetafile` the guard reads — `Bun.BuildMetafile` satisfies it as is. */
export interface IslandMetafile {
  readonly outputs: Readonly<
    Record<
      string,
      { readonly inputs: Readonly<Record<string, { readonly bytesInOutput: number }>> }
    >
  >;
}

/** The filesystem the guard asks, injectable so a Windows tree can be judged on a Linux runner. */
export interface ModuleIdentityIo {
  /** What Bun's metafile keys are relative to: the BUILDING process's cwd (`island-sources.ts`). */
  readonly cwd: string;
  /** win32 compares case-insensitively and treats `\` and `/` as one separator. */
  readonly platform: NodeJS.Platform;
  /** Throws for a path with no file behind it — a virtual module keeps its own spelling. */
  readonly realpath: (path: string) => string;
  /** A file's text, or `undefined` when there is none. */
  readonly readText: (path: string) => Promise<string | undefined>;
}

export const hostIo = (): ModuleIdentityIo => ({
  cwd: process.cwd(),
  platform: process.platform,
  realpath: (path) => realpathSync(path),
  readText: async (path) => {
    const file = Bun.file(path);
    return (await file.exists()) ? file.text() : undefined;
  },
});

/**
 * `path` as `island-package-dedupe.ts` spells every framework file it answers: the realpath. What a
 * resolver answered under another spelling (a Windows junction) is renamed through this before a
 * plugin hands it to `Bun.build`, so one file is one module string. A path with no file stays.
 */
export function realSpelling(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** One module an output carries more than once. */
export interface DuplicatedModule {
  /** The output path as the metafile names it. */
  readonly output: string;
  /** Every spelling it was bundled under, absolute, in the metafile's order. */
  readonly spellings: readonly string[];
  /** Bytes the output carries beyond its largest copy. */
  readonly wastedBytes: number;
  /** One file under several spellings (`true`), or byte-identical copies of one package (`false`). */
  readonly sameFile: boolean;
  /** `name@version` when the copies are a package's. */
  readonly package?: string;
  /** The package's `name` alone — what `bun why` is asked about. */
  readonly packageName?: string;
}

interface Input {
  readonly spelling: string;
  readonly bytes: number;
  readonly canonical: string;
}

interface PackageOf {
  readonly id: string;
  readonly name: string;
  readonly subpath: string;
}

/** The realpath, `/`-separated, lowercased where the filesystem is case-insensitive. */
function canonicalOf(absolute: string, io: ModuleIdentityIo): string {
  let real = absolute;
  try {
    real = io.realpath(absolute);
  } catch {
    // No file behind it: a virtual module, judged by its spelling alone.
  }
  const slashed = real.replace(/^\\\\\?\\/, '').replaceAll('\\', '/');
  return io.platform === 'win32' ? slashed.toLowerCase() : slashed;
}

/** The nearest `package.json` with a `name` above `file`, as `name@version` + the file under it. */
async function packageOf(
  file: string,
  io: ModuleIdentityIo,
  manifests: Map<string, Promise<{ name: string; version: string } | null>>,
): Promise<PackageOf | undefined> {
  const path = io.platform === 'win32' ? win32 : posix;
  for (let dir = path.dirname(file); ; dir = path.dirname(dir)) {
    let pending = manifests.get(dir);
    if (pending === undefined) {
      pending = io.readText(path.join(dir, 'package.json')).then(namedManifest);
      manifests.set(dir, pending);
    }
    const found = await pending;
    if (found !== null) {
      const subpath = path.relative(dir, file).replaceAll('\\', '/');
      const id = `${found.name}@${found.version}`;
      return {
        id,
        name: found.name,
        subpath: io.platform === 'win32' ? subpath.toLowerCase() : subpath,
      };
    }
    if (path.dirname(dir) === dir) return undefined;
  }
}

function namedManifest(text: string | undefined): { name: string; version: string } | null {
  if (text === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { name, version } = parsed as Record<string, unknown>;
    return typeof name === 'string'
      ? { name, version: typeof version === 'string' ? version : '' }
      : null;
  } catch {
    return null;
  }
}

/**
 * Every module an output carries twice: first by canonical path, then — between inputs that are
 * still distinct — by package. Two copies count as one module only when they are the same file of
 * the same `name@version` AND hold the same bytes, so a patched or differently-versioned copy is
 * left alone. Contents are read only for a package collision, never for every input.
 */
export async function duplicatedModules(
  metafile: IslandMetafile,
  io: ModuleIdentityIo,
): Promise<readonly DuplicatedModule[]> {
  const path = io.platform === 'win32' ? win32 : posix;
  const manifests = new Map<string, Promise<{ name: string; version: string } | null>>();
  const found: DuplicatedModule[] = [];
  for (const [output, { inputs }] of Object.entries(metafile.outputs)) {
    const byPath = new Map<string, Input[]>();
    for (const [key, { bytesInOutput }] of Object.entries(inputs)) {
      // A namespaced key (`x-realtime-island:…`) is a virtual module: no file, no second spelling.
      if (/^[a-z][\w-]+:(?![\\/])/i.test(key)) continue;
      const spelling = path.resolve(io.cwd, key);
      const canonical = canonicalOf(spelling, io);
      const group = byPath.get(canonical) ?? [];
      group.push({ spelling, bytes: bytesInOutput, canonical });
      byPath.set(canonical, group);
    }
    for (const group of byPath.values()) {
      if (group.length > 1) found.push(duplicate(output, group, true));
    }
    found.push(...(await packageCopies(output, [...byPath.values()], io, manifests)));
  }
  return found;
}

/** Distinct files that are one package's one file, byte for byte, under two install paths. */
async function packageCopies(
  output: string,
  groups: readonly (readonly Input[])[],
  io: ModuleIdentityIo,
  manifests: Map<string, Promise<{ name: string; version: string } | null>>,
): Promise<readonly DuplicatedModule[]> {
  const byPackage = new Map<string, { pkg: PackageOf; inputs: Input[] }>();
  for (const group of groups) {
    const first = group[0];
    if (first === undefined) continue;
    const pkg = await packageOf(first.spelling, io, manifests);
    if (pkg === undefined) continue;
    const key = `${pkg.id}/${pkg.subpath}`;
    const entry = byPackage.get(key) ?? { pkg, inputs: [] };
    entry.inputs.push(first);
    byPackage.set(key, entry);
  }
  const found: DuplicatedModule[] = [];
  for (const { pkg, inputs } of byPackage.values()) {
    if (inputs.length < 2) continue;
    const byHash = new Map<string, Input[]>();
    for (const input of inputs) {
      const text = await io.readText(input.spelling);
      if (text === undefined) continue;
      const hash = String(Bun.hash(text));
      byHash.set(hash, [...(byHash.get(hash) ?? []), input]);
    }
    for (const same of byHash.values()) {
      if (same.length > 1) found.push(duplicate(output, same, false, pkg.id, pkg.name));
    }
  }
  return found;
}

function duplicate(
  output: string,
  inputs: readonly Input[],
  sameFile: boolean,
  id?: string,
  name?: string,
): DuplicatedModule {
  const bytes = inputs.map((one) => one.bytes);
  const wastedBytes = bytes.reduce((sum, one) => sum + one, 0) - Math.max(...bytes);
  return {
    output,
    spellings: inputs.map((one) => one.spelling),
    wastedBytes,
    sameFile,
    ...(id === undefined ? {} : { package: id }),
    ...(name === undefined ? {} : { packageName: name }),
  };
}
