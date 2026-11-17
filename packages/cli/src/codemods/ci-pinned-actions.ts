// 31.43.0: the workflows `x new` writes run every action by commit SHA (`templates/github/
// actions.ts`), and ci.yml's checkouts drop the job token before `bun install`. Each stock line is
// swapped wherever it stands — every occurrence is the template's, so many is no guess — and a
// file still holding a movable `actions/*` tag after the swap is the author's, reported whole.

import { CACHE, CHECKOUT, DOWNLOAD_ARTIFACT, UPLOAD_ARTIFACT } from '../templates/github/actions';
import { CI_WORKFLOW_PATH } from '../templates/github/ci.yml';
import { IMAGE_WORKFLOW_PATH } from '../templates/github/image.yml';
import type { Codemod, CodemodApp, CodemodResult } from './codemod';
import { unifiedDiff } from './engine-diff';
import type { SnippetEdit } from './engine-edits';
import { mergeResults, readText } from './engine-edits';

const SETUP_BUN = '      - uses: oven-sh/setup-bun@';

/** ci.yml: each checkout is followed by setup-bun, so it has no `with:` of its own to collide. */
export const CI_PINNED_EDITS: readonly SnippetEdit[] = [
  {
    from: `      - uses: actions/checkout@v7\n${SETUP_BUN}`,
    to: `      - uses: ${CHECKOUT}\n        with:\n          persist-credentials: false\n${SETUP_BUN}`,
  },
  { from: '      - uses: actions/cache@v6\n', to: `      - uses: ${CACHE}\n` },
  { from: '      - uses: actions/upload-artifact@v7\n', to: `      - uses: ${UPLOAD_ARTIFACT}\n` },
  {
    from: '      - uses: actions/download-artifact@v8\n',
    to: `      - uses: ${DOWNLOAD_ARTIFACT}\n`,
  },
];

/** image.yml: its checkout already set `persist-credentials: false`; only the pin moves. */
export const IMAGE_PINNED_EDITS: readonly SnippetEdit[] = [
  { from: '      - uses: actions/checkout@v7\n', to: `      - uses: ${CHECKOUT}\n` },
];

/** A GitHub-owned action still on a tag: what a stock file never holds once the edits ran. */
const MOVABLE = /uses:\s*actions\/[\w./-]+@v\d[^\n]*$/m;

const NOTHING: CodemodResult = { changed: [], skipped: [] };

async function pin(
  app: CodemodApp,
  path: string,
  edits: readonly SnippetEdit[],
): Promise<CodemodResult> {
  const file = await readText(app, path);
  if (file === undefined) return NOTHING;
  const next = edits.reduce((source, edit) => source.replaceAll(edit.from, edit.to), file.text);
  if (MOVABLE.test(next)) {
    const side = (key: 'from' | 'to') => `${edits.map((edit) => edit[key]).join('\n')}\n`;
    return {
      changed: [],
      skipped: [
        {
          path,
          reason: `${path} runs an actions/* step by movable tag in a shape the scaffold never wrote (${MOVABLE.exec(next)?.[0].trim() ?? ''}), so the diff below is the template's change, to make by hand`,
          diff: unifiedDiff(path, side('from'), side('to')),
        },
      ],
    };
  }
  if (next === file.text) return NOTHING;
  await app.write(path, file.restore(next));
  return { changed: [path], skipped: [] };
}

export const codemod: Codemod = {
  id: 'ci-pinned-actions',
  since: '31.43.0',
  summary: `${CI_WORKFLOW_PATH}, ${IMAGE_WORKFLOW_PATH}: every actions/* step pinned by commit SHA, and ci.yml's checkouts keep no git credential`,
  run: async (app) =>
    mergeResults([
      await pin(app, CI_WORKFLOW_PATH, CI_PINNED_EDITS),
      await pin(app, IMAGE_WORKFLOW_PATH, IMAGE_PINNED_EDITS),
    ]),
};
