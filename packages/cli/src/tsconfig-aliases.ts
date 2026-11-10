// The package names a tsconfig's `compilerOptions.paths` answers for, read through its `extends`
// chain. An alias resolves through the compiler and Bun's own tsconfig reading, never through
// `node_modules`, so a rule asking "is this import declared?" must not treat one as a package.

import { dirname, isAbsolute, join } from 'node:path'; // why: Bun exposes no path primitives.
import { packageOfSpecifier } from './workspace-graph';

type JsonObject = Readonly<Record<string, unknown>>;

const asRecord = (value: unknown): JsonObject | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;

/** JSONC: a tsconfig may carry comments and trailing commas. Absent or unreadable says nothing. */
async function readTsconfig(path: string): Promise<JsonObject | undefined> {
  const file = Bun.file(path);
  if (!(await file.exists())) return undefined;
  try {
    return asRecord(Bun.JSONC.parse(await file.text()));
  } catch {
    return undefined;
  }
}

/**
 * Where one `extends` entry points. Relative and absolute paths as TypeScript reads them (`.json`
 * appended when absent); a package specifier through Bun's resolver, trying the package's own
 * `tsconfig.json` first as TypeScript does. A specifier that does not resolve says nothing.
 */
function extendedPath(entry: string, from: string): string | undefined {
  if (entry.startsWith('.') || isAbsolute(entry)) {
    const path = isAbsolute(entry) ? entry : join(from, entry);
    return path.endsWith('.json') ? path : `${path}.json`;
  }
  const candidates = entry.endsWith('.json') ? [entry] : [`${entry}/tsconfig.json`, entry];
  for (const candidate of candidates) {
    try {
      return Bun.resolveSync(candidate, from);
    } catch {
      // The next spelling, then nothing.
    }
  }
  return undefined;
}

/**
 * The effective `paths` of the tsconfig at `path`: its own when it declares any, else the last
 * `extends` entry's that does — TypeScript replaces `paths` wholesale, never merges it. `seen`
 * stops a cycle, which TypeScript refuses and this must not loop on.
 */
async function effectivePaths(
  path: string,
  seen: Set<string> = new Set(),
): Promise<JsonObject | undefined> {
  if (seen.has(path)) return undefined;
  seen.add(path);
  const config = await readTsconfig(path);
  if (config === undefined) return undefined;
  const own = asRecord(asRecord(config['compilerOptions'])?.['paths']);
  if (own !== undefined) return own;
  const extended = config['extends'];
  const entries =
    typeof extended === 'string' ? [extended] : Array.isArray(extended) ? extended : [];
  let inherited: JsonObject | undefined;
  for (const entry of entries) {
    if (typeof entry !== 'string') continue;
    const target = extendedPath(entry, dirname(path));
    const paths = target === undefined ? undefined : await effectivePaths(target, seen);
    if (paths !== undefined) inherited = paths;
  }
  return inherited;
}

/** Every package name the `tsconfig.json` in each of `dirs` aliases, unioned. */
export async function tsconfigAliases(dirs: readonly string[]): Promise<ReadonlySet<string>> {
  const aliases = new Set<string>();
  for (const dir of dirs) {
    for (const key of Object.keys((await effectivePaths(join(dir, 'tsconfig.json'))) ?? {})) {
      const name = packageOfSpecifier(key.replace(/\/?\*.*$/, ''));
      if (name !== undefined) aliases.add(name);
    }
  }
  return aliases;
}
