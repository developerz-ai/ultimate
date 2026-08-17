// How many entities an app declares, answered the way this package answers every question about a
// primitive: load the app, then project the registry — never a scan of the source. An entity may be
// declared anywhere `loadApp` reaches, so a text rule over `packages/db/src` would miss the ones
// that are not there and mistake a type-only import for a declaration.

import { describeEntities } from '@ultimat3/entity';
import { loadApp } from './app-load';

/**
 * A module that will not import registers nothing, so a broken app answers with a SHORT count and
 * never a throw — `loadApp` collects import failures as findings rather than raising them. Callers
 * must therefore read a zero as "nothing is declared *that this process could load*", which is why
 * the one caller uses it to go quiet rather than to accuse.
 */
export async function countDeclaredEntities(root: string): Promise<number> {
  await loadApp(root);
  return describeEntities().length;
}
