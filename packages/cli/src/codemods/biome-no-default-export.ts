// 31.6.0: named exports only, as a lint rule — biome.json turns on `noDefaultExport`, off for
// `scss.d.ts`. Turned on only where the app holds no default export: elsewhere the change is
// reported with the files it would red, never a lint failure the hop introduced.

import type { Codemod } from './codemod';
import { unifiedDiff } from './engine-diff';
import type { SnippetEdit } from './engine-edits';
import { editSnippets, fileText } from './engine-edits';

const BIOME = 'biome.json';

export const BIOME_EDITS: readonly SnippetEdit[] = [
  {
    from: '      "style": { "useNodejsImportProtocol": "error" }',
    to: '      "style": { "useNodejsImportProtocol": "error", "noDefaultExport": "error" }',
  },
  {
    from: '  "overrides": [\n    {\n      "includes": ["**/*.scss"],',
    to: '  "overrides": [\n    {\n      "includes": ["**/scss.d.ts"],\n      "linter": { "rules": { "style": { "noDefaultExport": "off" } } }\n    },\n    {\n      "includes": ["**/*.scss"],',
  },
];

/** The app's own sources that default-export: what the rule would red. */
async function defaultExports(app: Parameters<Codemod['run']>[0]): Promise<readonly string[]> {
  const found: string[] = [];
  for (const path of await app.glob('**/*.{ts,tsx,js,mjs}')) {
    if (path.includes('node_modules/') || path.endsWith('scss.d.ts')) continue;
    if (/^export default\b/m.test((await app.read(path)) ?? '')) found.push(path);
  }
  return found;
}

export const codemod: Codemod = {
  id: 'biome-no-default-export',
  since: '31.6.0',
  summary: `${BIOME}: noDefaultExport is an error, off for scss.d.ts — named exports only`,
  async run(app) {
    const held = await app.read(BIOME);
    if (held === undefined || held.includes('"noDefaultExport"'))
      return { changed: [], skipped: [] };
    // Not the file x new wrote (a monorepo child extending the repo's): its rules are the app's.
    const text = fileText(held).text;
    if (BIOME_EDITS.some((edit) => !text.includes(edit.from))) return { changed: [], skipped: [] };
    const blocking = await defaultExports(app);
    if (blocking.length === 0) return editSnippets(app, BIOME, BIOME_EDITS);
    const wanted = BIOME_EDITS.reduce((text, edit) => text.replace(edit.from, () => edit.to), held);
    return {
      changed: [],
      skipped: [
        {
          path: BIOME,
          reason: `noDefaultExport left off: ${blocking.slice(0, 5).join(', ')} default-export, and the rule would red lint. Make them named exports, then apply the diff`,
          diff: unifiedDiff(BIOME, held, wanted),
        },
      ],
    };
  },
};
