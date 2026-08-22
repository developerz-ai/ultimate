// Routes: the URL and what it serves. `surface` is the contract — a URL that answered HTML and
// now answers JSON breaks every link to it — while the delivery facts (`render`, `offline`,
// `hydrate`, `budget`, `revalidateTags`) are internal and reported.

import { canonicalJson } from '@ultimat3/core';
import type { ManifestChange } from './diff-change';
import { diffScalar, index } from './diff-change';
import type { RouteFact } from './schema';

export function diffRoutes(
  before: readonly RouteFact[],
  after: readonly RouteFact[],
): readonly ManifestChange[] {
  const changes: ManifestChange[] = [];
  const afterByUrl = index(after, (r) => r.url);
  const beforeByUrl = index(before, (r) => r.url);

  for (const route of before) {
    const next = afterByUrl.get(route.url);
    const path = `routes.${route.url}`;
    if (next === undefined) {
      // A removed URL is a 404 for anyone holding a link to it.
      changes.push({ kind: 'breaking', path, detail: 'route removed' });
      continue;
    }
    // `site`, `app` and `api` are three different promises about one URL: a page becoming an API
    // route stops rendering HTML for every crawler and bookmark pointing at it.
    changes.push(
      ...diffScalar(
        'breaking',
        `${path}.surface`,
        route.surface,
        next.surface,
        (from, to) => `surface ${from} -> ${to}`,
      ),
    );
    // The delivery facts, each with its own path so a reviewer sees WHICH one moved. Every one is
    // optional in the file, and `diffScalar` skips a side that carries nothing: a manifest written
    // before a field existed must not report every route as changed the first time it is diffed.
    changes.push(
      ...diffScalar(
        'internal',
        `${path}.render`,
        route.render,
        next.render,
        (from, to) => `render ${from} -> ${to}`,
      ),
      ...diffScalar(
        'internal',
        `${path}.offline`,
        route.offline,
        next.offline,
        (from, to) => `offline ${from} -> ${to}`,
      ),
      ...diffScalar(
        'internal',
        `${path}.hydrate`,
        route.hydrate,
        next.hydrate,
        (from, to) => `hydrate ${from} -> ${to}`,
      ),
    );
    changes.push(...diffJson('internal', `${path}.budget`, route.budget, next.budget, 'changed'));
    changes.push(
      ...diffJson(
        'internal',
        `${path}.revalidateTags`,
        route.revalidateTags,
        next.revalidateTags,
        'revalidate tags changed',
      ),
    );
  }
  for (const route of after) {
    if (!beforeByUrl.has(route.url)) {
      changes.push({ kind: 'additive', path: `routes.${route.url}`, detail: 'route added' });
    }
  }
  return changes;
}

/** The structural sibling of `diffScalar`: absent on either side is still no evidence. */
function diffJson(
  kind: ManifestChange['kind'],
  path: string,
  before: unknown,
  after: unknown,
  detail: string,
): readonly ManifestChange[] {
  if (before === undefined || after === undefined) return [];
  if (canonicalJson(before) === canonicalJson(after)) return [];
  return [{ kind, path, detail }];
}
