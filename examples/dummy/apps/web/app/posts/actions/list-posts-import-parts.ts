// `listPostsImportParts`, the posts slice's action — one primitive per file, the layout `x g` writes.

import { action, t } from '@ultimat3/action';
import { disk, listParts } from '@ultimat3/storage';
import { ImportSession } from '../import-upload';
import { postImport } from '../policy';

/** What already landed, ascending: the resume — a client sends only the parts missing here. */
export const listPostsImportParts = action({
  input: ImportSession,
  output: t.array(t.object({ partNumber: t.number.int(), etag: t.string, size: t.number.int() })),
  policy: postImport,
  async handle({ input }) {
    return [...(await listParts({ disk: disk(), ...input }))];
  },
});
