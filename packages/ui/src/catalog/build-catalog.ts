// The one walk over `src/components/*.tsx` that both the writer and the drift test use, so the
// committed CATALOG.md and the test's expectation can never come from two different file sets.

import type { ComponentDoc } from './parse-component';
import { parseComponents } from './parse-component';
import { renderCatalog } from './render-catalog';

const COMPONENTS_DIR = new URL('../components/', import.meta.url).pathname;
export const CATALOG_PATH = new URL('../../CATALOG.md', import.meta.url).pathname;

/** Alphabetical by file, so the page's order is the order an agent scans for a name. */
export async function collectComponents(): Promise<ComponentDoc[]> {
  const files: string[] = [];
  for await (const file of new Bun.Glob('*.tsx').scan({ cwd: COMPONENTS_DIR })) {
    files.push(file);
  }
  files.sort();

  const docs: ComponentDoc[] = [];
  for (const file of files) {
    docs.push(...parseComponents(await Bun.file(`${COMPONENTS_DIR}${file}`).text()));
  }
  return docs;
}

export async function buildCatalog(): Promise<string> {
  return renderCatalog(await collectComponents());
}

if (import.meta.main) {
  await Bun.write(CATALOG_PATH, await buildCatalog());
}
