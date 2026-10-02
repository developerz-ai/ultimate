// The workspace edges `x g` just wrote, declared in the manifest of the workspace each file landed
// in. `package-shape` refuses an import its owner does not declare (X_WORKSPACE_DEP_UNDECLARED), and
// a generator that emits one hands the author a red gate for the generator's own output — the edit
// is mechanical, so the generator makes it. Shipped source only, the checker's own scope.

import { containedPath } from './generate-write';
import { isGenerated, isTest } from './source-files';
import { withDependency } from './workspace-dep-edit';
import { importedPackages, scanWorkspaces, type WorkspaceNode } from './workspace-graph';

const SOURCE = /\.tsx?$/;

/** Per owning workspace, the sibling workspaces its new files import and it does not declare. */
async function missingEdges(
  root: string,
  written: readonly string[],
): Promise<Map<WorkspaceNode, Map<string, string>>> {
  const missing = new Map<WorkspaceNode, Map<string, string>>();
  const sources = written.filter(
    (path) => SOURCE.test(path) && !isTest(path) && !isGenerated(path),
  );
  if (sources.length === 0) return missing;
  const { nodes } = await scanWorkspaces(root);
  const byName = new Map(nodes.map((node) => [node.name, node]));
  // Deepest directory first, as the checker reads it: a nested workspace's files are its own.
  const owners = [...nodes].sort((left, right) => right.dir.length - left.dir.length);
  for (const path of sources) {
    const owner = owners.find((node) => path.startsWith(`${node.dir}/`));
    if (owner === undefined) continue;
    const text = await Bun.file(containedPath(root, path)).text();
    for (const name of importedPackages(text, path)) {
      const target = byName.get(name);
      if (target === undefined || target === owner || owner.dependencies.includes(name)) continue;
      const edges = missing.get(owner) ?? new Map<string, string>();
      edges.set(name, target.version ?? '0.0.0');
      missing.set(owner, edges);
    }
  }
  return missing;
}

/** Writes each owning manifest once, holding every new edge; answers the manifests it rewrote. */
export async function declareGeneratedImports(
  root: string,
  written: readonly string[],
): Promise<readonly string[]> {
  const edited: string[] = [];
  for (const [owner, edges] of await missingEdges(root, written)) {
    const path = `${owner.dir}/package.json`;
    const file = Bun.file(containedPath(root, path));
    const before = await file.text();
    let after = before;
    for (const [name, version] of edges) after = withDependency(after, name, version) ?? after;
    if (after === before) continue;
    await Bun.write(containedPath(root, path), after);
    edited.push(path);
  }
  return edited;
}
