// What the hop did NOT carry: the hopped fixture against HEAD's own `x new` of the same name, file
// by file. Not a verdict — an example slice is the app's once scaffolded — but every scaffold-owned
// file listed here is a template change no codemod brought across, which is the codemod work list.

// why: Bun exposes no path-join primitive.
import { join } from 'node:path';

/** The per-box and generated files a first run writes and no template does. */
const GENERATED = [
  /^bun\.lock$/,
  /^x\.manifest\.json$/,
  /^openapi\.json$/,
  /^packages\/db\/migrations\//,
  /^packages\/db\/schema\//,
  /^\.env\.development\.local$/,
  /(^|\/)node_modules\//,
  /^\.x\//,
  /^\.git\//,
  /^\.npmrc$/,
  /\.tsbuildinfo$/,
];

const generated = (path: string): boolean => GENERATED.some((pattern) => pattern.test(path));

export interface ScaffoldDrift {
  /** In HEAD's scaffold, absent from the hopped app: a file the release added. */
  readonly missing: readonly string[];
  /** In both, with different bytes: a template change, or the app's own edit. */
  readonly differs: readonly string[];
  /** In the hopped app only, generated files aside: a file the release removed or renamed. */
  readonly extra: readonly string[];
}

/** Pure: two trees as path → bytes, compared with every generated path left out. */
export const driftOf = (
  head: ReadonlyMap<string, string>,
  app: ReadonlyMap<string, string>,
): ScaffoldDrift => {
  const missing: string[] = [];
  const differs: string[] = [];
  for (const [path, text] of head) {
    if (generated(path)) continue;
    const held = app.get(path);
    if (held === undefined) missing.push(path);
    else if (held !== text) differs.push(path);
  }
  const extra = [...app.keys()].filter((path) => !generated(path) && !head.has(path));
  return { missing: missing.sort(), differs: differs.sort(), extra: extra.sort() };
};

/** Every file under `dir`, dotfiles included, generated trees never entered. */
export async function readTree(dir: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  const glob = new Bun.Glob('**/*');
  for await (const path of glob.scan({
    cwd: dir,
    dot: true,
    onlyFiles: true,
    followSymlinks: false,
  })) {
    const posix = path.replaceAll('\\', '/');
    if (generated(posix)) continue;
    files.set(posix, await Bun.file(join(dir, path)).text());
  }
  return files;
}
