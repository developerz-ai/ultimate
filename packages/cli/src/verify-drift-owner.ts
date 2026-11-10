// The `drift` step's ownership rail: one repository is ONE app — one `app.config.ts` at the root,
// one registry every `apps/*` workspace boots into, one image whose `ROLE` picks the process, one
// `packages/db/migrations`. A second `app.config.ts` inside a workspace makes `x` treat that
// directory as its own root (its own migrations, its own image), so it is refused here by code.

import { ERROR_DOCS_URL } from '@ultimat3/core';
import { commentSafe } from './comment-safe';
import type { Finding } from './output';
import { hasPathSegment } from './path-segments';
import { toPosix } from './posix-path';

const NESTED_CONFIG = '{apps,packages}/**/app.config.ts';

/** Every `app.config.ts` below `apps/` or `packages/`, sorted, never a dependency's. */
export async function nestedAppRootFindings(root: string): Promise<readonly Finding[]> {
  const found: string[] = [];
  for await (const path of new Bun.Glob(NESTED_CONFIG).scan({ cwd: root, absolute: false })) {
    if (!hasPathSegment(path, 'node_modules')) found.push(toPosix(path));
  }
  return found.sort().map((path) => {
    const workspace = path.slice(0, -'/app.config.ts'.length);
    return {
      code: 'X_APP_ROOT_NESTED',
      cause: `${path} makes ${workspace} a second app root — its own registry, migrations and image. One repository is one app: every apps/* workspace boots in the one image (ROLE picks the process) and packages/db/migrations is the one migration owner`,
      fix: `x verify --only drift --json   # after deleting ${commentSafe(path)} and moving what it configured into the root app.config.ts`,
      docs: ERROR_DOCS_URL,
      at: path,
    };
  });
}
