// `signPostsImportPart`, the posts slice's action — one primitive per file, the layout `x g` writes.

import { action, t } from '@ultimat3/action';
import { disk, signPart } from '@ultimat3/storage';
import { ImportSession } from '../import-upload';
import { postImport } from '../policy';

/** One part's URL, its exact length inside the signature: the part cannot land at any other size. */
export const signPostsImportPart = action({
  input: ImportSession.extend({
    partNumber: t.number.int().min(1).max(10_000),
    size: t.number.int().min(1),
  }),
  output: t.object({ url: t.string }),
  policy: postImport,
  async handle({ input }) {
    return { url: await signPart({ disk: disk(), ...input }) };
  },
});
