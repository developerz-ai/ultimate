// Which islands one `Bun.build` bundles together: the islands every route renders TOGETHER, and no
// other. Two islands named by exactly the same route files are one split build, so the code they
// share is one chunk a page fetches once; every other island is built alone, byte for byte what it
// always was.
//
// Read from the route files' sources, so `x dev`, the container, the image's store and the static
// export all derive one grouping from one tree — none of them needs a render pass.
//
// Measured on examples/dummy, As of 2026-11-10 (Bun 1.4.4): `/posts/:id` renders like, likes-badge
// and summary on that route only — its islands' bytes 95,754 → 65,676 B (runtime chunk aside);
// every other route of the three tracked apps byte-identical. One global split build
// (`islands.sharedChunks`) got that route to 70,462 B and charged six others +910…+9,154 B.

// why: Bun ships no path API; an island's file is its route file's directory joined to its `src`.
import { posix } from 'node:path';
import { ISLAND_EXTENSION, ROUTE_FILENAME } from '@ultimat3/render';
import { hasPathSegment } from './path-segments';
import { posixRelative } from './posix-path';

/** Every route file that can declare an island: `page.tsx` on the surfaces that render documents. */
const ROUTE_GLOB = `apps/*/{site,app}/**/${ROUTE_FILENAME.site}`;

/** A string literal naming an island file — quoted, double-quoted or a template with no holes. */
const ISLAND_LITERAL = /(["'`])([^"'`\s$]+\.island\.tsx)\1/g;

/**
 * Comments are dropped by transpiling first, so a page whose prose names another page's island
 * does not join that island's group. Unused declarations are KEPT: `island()` at module scope is
 * the declaration, rendered or not, and a dynamic route renders a different subset per params.
 */
const transpiler = new Bun.Transpiler({
  loader: 'tsx',
  deadCodeElimination: false,
  trimUnusedImports: false,
});

/** The page's code without its comments — or as written, when it does not parse. */
function codeOf(source: string): string {
  try {
    return transpiler.transformSync(source);
  } catch {
    // A page that does not parse fails its own load with its own code (`X_APP_MODULE_LOAD_FAILED`);
    // grouping is a byte saving, never a verdict, so it reads the literals as written.
    return source;
  }
}

/**
 * Each route file (app-root-relative, POSIX) → the islands it names, resolved from its directory
 * the way `resolverFor` resolves a `src`. Only files in `islands` count: a literal naming nothing
 * built cannot be grouped, and the render refuses it by name (`X_ISLAND_INVALID`).
 */
export async function routeIslandReferences(
  root: string,
  islands: ReadonlySet<string>,
): Promise<ReadonlyMap<string, ReadonlySet<string>>> {
  const references = new Map<string, ReadonlySet<string>>();
  for await (const absolute of new Bun.Glob(ROUTE_GLOB).scan({ cwd: root, absolute: true })) {
    if (hasPathSegment(absolute, 'node_modules')) continue;
    const source = await Bun.file(absolute).text();
    if (!source.includes(ISLAND_EXTENSION)) continue;
    const file = posixRelative(root, absolute);
    const dir = posix.dirname(file);
    const named = new Set<string>();
    for (const match of codeOf(source).matchAll(ISLAND_LITERAL)) {
      const target = posix.normalize(posix.join(dir, match[2] ?? ''));
      if (islands.has(target)) named.add(target);
    }
    if (named.size > 0) references.set(file, named);
  }
  return references;
}

const byFirst = (a: readonly string[], b: readonly string[]): number => {
  const [x = '', y = ''] = [a[0], b[0]];
  return x < y ? -1 : x > y ? 1 : 0;
};

/**
 * The partition: islands keyed by the set of routes naming them. Same key, same group —
 * so every route loading one member loads all of them, and no route pays for a member it does not
 * render. An island on many routes (a layout-wide banner) has a key of its own and stays alone,
 * with no rule naming it. Groups of more than one first, each sorted, then the solos — so the
 * partition is a function of the sources, never of the order a glob answered in.
 */
export function groupIslands(
  islands: readonly string[],
  references: ReadonlyMap<string, ReadonlySet<string>>,
): readonly (readonly string[])[] {
  const routesOf = new Map<string, string[]>();
  for (const [route, named] of references) {
    for (const island of named) routesOf.set(island, [...(routesOf.get(island) ?? []), route]);
  }
  const byKey = new Map<string, string[]>();
  for (const island of [...islands].sort()) {
    const routes = routesOf.get(island);
    // One walk of `references` built every list, so equal sets are equal strings unsorted. No route
    // names it: alone, under a key no route set can spell.
    const key = routes === undefined ? `\0${island}` : routes.join('\n');
    byKey.set(key, [...(byKey.get(key) ?? []), island]);
  }
  const groups = [...byKey.values()];
  return [
    ...groups.filter((group) => group.length > 1).sort(byFirst),
    ...groups.filter((group) => group.length === 1).sort(byFirst),
  ];
}

/** `islands`, partitioned by the routes of the app at `root` that render them together. */
export async function islandGroups(
  root: string,
  islands: readonly string[],
): Promise<readonly (readonly string[])[]> {
  return groupIslands(islands, await routeIslandReferences(root, new Set(islands)));
}
