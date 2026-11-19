// Which file `x g` edits the role map in. The scaffold's `apps/web/shared/roles.ts` when it is
// there; otherwise the ONE module beside it that calls `defineRoles(` — the reference app keeps
// its map in `shared/policies.ts`, and a fixed path granted nothing there on every run.

import { stripComments } from '@ultimat3/core';
import type { GenerateDisk } from './generate-disk';
import { ROLES_FILE } from './permission-grants';
import { isTest } from './source-files';

/** Where an app's role map can live without the app being loaded: the shared leaf, one level. */
const SHARED_GLOB = 'apps/web/shared/*.ts';

/**
 * `undefined` when no file, or more than one, declares the map: a generator never picks between
 * two, and the finding then says what nobody granted. Read off disk, not the registry — `x g` does
 * not load the app, and the edit that follows is of this source text in either case.
 */
export async function rolesFileOf(root: string, disk: GenerateDisk): Promise<string | undefined> {
  if ((await disk.read(ROLES_FILE)) !== undefined) return ROLES_FILE;
  const declaring: string[] = [];
  for await (const path of new Bun.Glob(SHARED_GLOB).scan({ cwd: root })) {
    const file = path.replaceAll('\\', '/');
    if (isTest(file)) continue;
    const source = await disk.read(file);
    if (source !== undefined && /\bdefineRoles\s*\(/.test(stripComments(source))) {
      declaring.push(file);
    }
  }
  return declaring.length === 1 ? declaring[0] : undefined;
}
