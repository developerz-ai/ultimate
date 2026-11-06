// `abortPostsImport`, the posts slice's action — one primitive per file, the layout `x g` writes.

import { action, t } from '@ultimat3/action';
import { abortUpload, disk } from '@ultimat3/storage';
import { ImportSession } from '../import-upload';
import { postImport } from '../policy';

/**
 * A cancelled upload drops its session and every part, so nothing bills for bytes nobody will
 * assemble. A session already gone is the state asked for. The hourly `purge()` sweeps the rest.
 */
export const abortPostsImport = action({
  input: ImportSession,
  output: t.object({ aborted: t.boolean }),
  policy: postImport,
  async handle({ input }) {
    await abortUpload({ disk: disk(), ...input });
    return { aborted: true };
  },
});
