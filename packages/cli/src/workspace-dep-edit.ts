// One workspace declaring another in its `package.json`, as a TEXT edit. A generator that makes
// `packages/db` import the web app owes the manifest line `package-shape` would otherwise demand
// (`X_WORKSPACE_DEP_UNDECLARED`), and re-serialising the whole file would reformat arrays and
// spacing the author — or their formatter — chose.

import { containedPath } from './generate-write';

const MANIFEST = 'package.json';

/** The fields a manifest edit reads. Anything else in the file is carried through untouched. */
interface Manifest {
  readonly name?: unknown;
  readonly version?: unknown;
  readonly dependencies?: unknown;
  readonly devDependencies?: unknown;
  readonly peerDependencies?: unknown;
}

function parseManifest(text: string): Manifest | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Manifest)
      : undefined;
  } catch {
    // A manifest that does not parse is `bun install`'s finding, and `package-shape`'s.
    return undefined;
  }
}

const stringRecord = (value: unknown): Readonly<Record<string, string>> =>
  typeof value === 'object' && value !== null
    ? Object.fromEntries(
        Object.entries(value).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string',
        ),
      )
    : {};

const declares = (manifest: Manifest, name: string): boolean =>
  [manifest.dependencies, manifest.devDependencies, manifest.peerDependencies].some((block) =>
    Object.hasOwn(stringRecord(block), name),
  );

/**
 * `manifest` with `name` declared under `dependencies`, or `undefined` when it already is — or
 * when the text is not a manifest this can edit safely. The block is rewritten from its parsed
 * entries, sorted the way `bun add` sorts them; every byte outside it is the author's.
 */
export function withDependency(
  manifest: string,
  name: string,
  version: string,
): string | undefined {
  const parsed = parseManifest(manifest);
  if (parsed === undefined || declares(parsed, name)) return undefined;
  const block = /^([ \t]*)"dependencies":\s*\{/m.exec(manifest);
  if (block === null) {
    const close = manifest.lastIndexOf('}');
    const body = manifest.slice(0, close).trimEnd();
    // `{}` has no property to put a comma after; nothing a scaffold writes is that.
    if (close === -1 || body.endsWith('{')) return undefined;
    return `${body},\n  "dependencies": {\n    "${name}": "${version}"\n  }\n}\n`;
  }
  const indent = block[1] ?? '';
  const open = block.index + block[0].length;
  const close = manifest.indexOf('}', open);
  if (close === -1) return undefined;
  const entries = Object.entries({ ...stringRecord(parsed.dependencies), [name]: version })
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${indent}  ${JSON.stringify(key)}: ${JSON.stringify(value)}`);
  return `${manifest.slice(0, open)}\n${entries.join(',\n')}\n${indent}${manifest.slice(close)}`;
}

/** A workspace's `name` and `version`, or `undefined` when its manifest supplies no name. */
export async function readWorkspace(
  root: string,
  dir: string,
): Promise<{ readonly name: string; readonly version: string } | undefined> {
  const file = Bun.file(containedPath(root, `${dir}/${MANIFEST}`));
  if (!(await file.exists())) return undefined;
  const parsed = parseManifest(await file.text());
  if (parsed === undefined || typeof parsed.name !== 'string' || parsed.name === '') {
    return undefined;
  }
  return {
    name: parsed.name,
    version: typeof parsed.version === 'string' ? parsed.version : '0.0.0',
  };
}

/** One file a caller is about to write: its app-root-relative path and its whole new text. */
export interface PlannedEdit {
  readonly path: string;
  readonly contents: string;
}

/**
 * The edit that declares the workspace at `toDir` in `fromDir`'s manifest, NOT yet written — a
 * registrar plans every file it touches and writes all of them or none. `undefined` when the edge
 * is already declared or either manifest is unreadable; the `package-shape` step then names the
 * line, which is the same edit by hand.
 */
export async function planWorkspaceDependency(
  root: string,
  fromDir: string,
  toDir: string,
): Promise<PlannedEdit | undefined> {
  const target = await readWorkspace(root, toDir);
  const path = `${fromDir}/${MANIFEST}`;
  const file = Bun.file(containedPath(root, path));
  if (target === undefined || !(await file.exists())) return undefined;
  const contents = withDependency(await file.text(), target.name, target.version);
  return contents === undefined ? undefined : { path, contents };
}

/** Declares it now. Answers the path it rewrote, or `undefined` when there was nothing to write. */
export async function declareWorkspaceDependency(
  root: string,
  fromDir: string,
  toDir: string,
): Promise<string | undefined> {
  const edit = await planWorkspaceDependency(root, fromDir, toDir);
  if (edit === undefined) return undefined;
  await Bun.write(containedPath(root, edit.path), edit.contents);
  return edit.path;
}
