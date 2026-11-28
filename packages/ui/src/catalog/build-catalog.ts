// The one walk over a package's component files that both the writer and the drift test use, so
// the committed CATALOG.md and the test's expectation can never come from two different file sets.
// It takes a package ROOT: `@ultimat3/effects` generates its page with this same walk.

import type { ComponentDoc } from './parse-component';
import { parseComponents } from './parse-component';
import { renderCatalog, renderComponentsCatalog } from './render-catalog';

/** `packages/ui` — the default root, and the only one whose page `renderCatalog` renders. */
export const UI_ROOT = Bun.fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');
export const CATALOG_PATH = `${UI_ROOT}/CATALOG.md`;
const UI_COMPONENTS_GLOB = 'src/components/*.tsx';

/** Alphabetical by file, so the page's order is the order an agent scans for a name. */
export async function collectComponents(
  root: string = UI_ROOT,
  pattern: string = UI_COMPONENTS_GLOB,
): Promise<ComponentDoc[]> {
  const files: string[] = [];
  for await (const file of new Bun.Glob(pattern).scan({ cwd: root })) {
    files.push(file);
  }
  files.sort();

  const docs: ComponentDoc[] = [];
  for (const file of files) {
    docs.push(...parseComponents(await Bun.file(`${root}/${file}`).text()));
  }
  return docs;
}

export async function buildCatalog(
  root: string = UI_ROOT,
  pattern: string = UI_COMPONENTS_GLOB,
  render: (components: readonly ComponentDoc[]) => string = renderCatalog,
): Promise<string> {
  return render(await collectComponents(root, pattern));
}

/**
 * `bun run catalog [<package root> <glob> [<title>]]`: no argument is ui's own page; a title
 * renders that package's components-only page (`renderComponentsCatalog`), as `@ultimat3/effects`
 * does. Answers the file to write and its text.
 */
export async function catalogFromArgs(
  args: readonly string[],
): Promise<{ readonly path: string; readonly text: string }> {
  const [root = UI_ROOT, pattern = UI_COMPONENTS_GLOB, title] = args;
  const render =
    title === undefined
      ? renderCatalog
      : (docs: readonly ComponentDoc[]) => renderComponentsCatalog(title, docs);
  return { path: `${root}/CATALOG.md`, text: await buildCatalog(root, pattern, render) };
}

if (import.meta.main) {
  const page = await catalogFromArgs(Bun.argv.slice(2));
  await Bun.write(page.path, page.text);
}
