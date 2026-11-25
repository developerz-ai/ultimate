// One load of an app in a process of its own — Bun's resolver and the registries are per-process —
// answering the findings it reported. For the tests of what a failed import is told.

import { expect } from 'bun:test';
// why: Bun ships no path joiner.
import { join } from 'node:path';
import type { Finding } from './output';

/** `file` exports `name`, which takes an app root and answers findings. */
export interface ChildLoader {
  readonly file: string;
  readonly name: string;
}

/** The findings of the tool's load of the app at `root`, or of another loader's. */
export async function childLoad(
  root: string,
  loader: ChildLoader = { file: 'app-load.ts', name: 'loadApp' },
): Promise<readonly Finding[]> {
  const script = `import { ${loader.name} as load } from ${JSON.stringify(join(import.meta.dir, loader.file))};
const app = await load(${JSON.stringify(root)});
await Bun.write(Bun.stdout, JSON.stringify(app.findings));`;
  const child = Bun.spawn(['bun', '-e', script], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 20_000,
  });
  const [out, err] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if ((await child.exited) !== 0) return expect.unreachable(`the load crashed: ${err}`);
  return JSON.parse(out) as readonly Finding[];
}
