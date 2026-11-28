// The agent kit as an app root holds it: the disk behind `judgeKit`, and the managed files rendered
// for the app's own name. One seam, so the gate, `x kit`, `x doctor` and `x upgrade` read the same.

// why: Bun exposes no path-join or basename primitive.
import { basename, join } from 'node:path';
import type { KitDisk, KitVerdict } from './app-kit';
import { judgeKit } from './app-kit';
import { appName } from './codemods/agents-dev-mcp';
import type { KitFile } from './kit/registry';
import { kitFiles } from './kit/registry';
import { names } from './templates/naming';

export const diskAt = (root: string): KitDisk => ({
  async read(path) {
    const file = Bun.file(join(root, path));
    return (await file.exists()) ? file.text() : undefined;
  },
  async glob(pattern) {
    const found: string[] = [];
    for await (const path of new Bun.Glob(pattern).scan({ cwd: root })) found.push(path);
    return found.sort();
  },
});

/** The name the scaffold spelled into the kit: the root `package.json`'s, else the directory's. */
export async function kitAppName(root: string): Promise<string> {
  const manifest = await diskAt(root).read('package.json');
  return (manifest === undefined ? undefined : appName(manifest)) ?? basename(root);
}

/** Every managed file rendered for the app at `root`. */
export async function managedKit(root: string): Promise<readonly KitFile[]> {
  return kitFiles(names(await kitAppName(root)));
}

/** The gate's, `x doctor`'s and `x upgrade`'s one question about an app. */
export async function kitVerdict(root: string): Promise<KitVerdict> {
  return judgeKit(diskAt(root), await managedKit(root));
}
