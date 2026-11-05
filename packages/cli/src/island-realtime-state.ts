// Which realtime islands have page state to RESTORE, and which only follow the socket. A held
// island (#506, `@ultimat3/render`'s `island-hold.ts`) is hidden until it mounts because its server
// markup can be older than the record store and the outbox the page boot restores. An island whose
// whole realtime use is a channel's events, a roster or the connection reads neither: its server
// markup is as current as any other island's, so hiding it only delayed the page's content.

import { registeredEntities } from '@ultimat3/entity';
import { firstInGraph } from './live-routes';

const REALTIME = '@ultimat3/realtime';

/**
 * The barrel's value exports that read neither the record store nor the outbox: a membership, its
 * roster, the socket's state, and the declarations that spell a topic. An ALLOW list on purpose —
 * a name this list has never heard of (a hook added next year) is state until someone says not.
 */
export const FOLLOW_ONLY_EXPORTS: readonly string[] = [
  'useChannel',
  'usePresence',
  'useConnection',
  'hasPageSocket',
  // Hears THAT records moved and renders none of them, so a restored store contradicts nothing.
  'useRecordChanges',
  // A timer value for `useQuery`'s `poll`: it reads nothing, so it adds no reason to hold.
  'pollEvery',
  'readPresence',
  'channel',
  'channelRef',
  'topic',
];

/**
 * A named import or re-export of the barrel, as `Bun.Transpiler` PRINTS one: a statement to a
 * line, double quotes, type-only names already erased. Read off the transpiler's output, never
 * off the author's source, so a comment or a multi-line clause is not this pattern's problem.
 */
const NAMED = /^(?:import|export) \{([^}]*)\} from "@ultimat3\/realtime";?$/gm;

/**
 * The barrel's names one module takes by value — `[]` when it takes none, `undefined` when it
 * takes the barrel in a form with no list of names (`import *`, `export *`, a bare or default
 * import, `import()`). Counted against the transpiler's own import records: a statement this file
 * cannot read is never silently skipped, it makes the answer unknown.
 */
export function realtimeBindings(source: string, path: string): readonly string[] | undefined {
  const transpiler = new Bun.Transpiler({ loader: path.endsWith('x') ? 'tsx' : 'ts' });
  const statements = transpiler.scanImports(source).filter((entry) => entry.path === REALTIME);
  if (statements.length === 0) return [];
  const names: string[] = [];
  let named = 0;
  for (const match of transpiler.transformSync(source).matchAll(NAMED)) {
    named += 1;
    for (const binding of (match[1] ?? '').split(',')) {
      const name = binding.split(/\sas\s/)[0]?.trim() ?? '';
      if (name !== '') names.push(name);
    }
  }
  return named === statements.length ? names : undefined;
}

/**
 * What a realtime island is to the page boot: `restores` reads the record store or the outbox
 * (held, and its `mount` waits for the restore), `follows` only follows the socket (neither).
 * Carried on the island's own chunk (`IslandChunk.realtime`), never in process state: an answer is
 * about one app's file, and two apps built in one process can spell two islands the same way.
 */
export type IslandRealtime = 'restores' | 'follows';

/**
 * The reads that restore something only when the app keeps a record type on disk: with none, the
 * boot restores no record their server markup could be older than. `useMutation` is not here —
 * the outbox rebuilds a queued write's overlay whatever the app persists.
 */
export const NO_DISK_FOLLOW_EXPORTS: readonly string[] = ['useQuery', 'useRecord'];

/**
 * Whether the loaded app keeps any record type on disk (`entity(…, { persist: true })`), read off
 * the entity registry the build process loaded the app into. An empty registry is `undefined`: an
 * app that registered nothing and a build that never loaded it look the same, so it is unknown.
 */
export function appPersistsRecords(): boolean | undefined {
  const entries = registeredEntities();
  if (entries.length === 0) return undefined;
  return entries.some((entry) => entry.persist === true);
}

/**
 * Whether a realtime island restores nothing: every module of its relative graph takes only
 * `FOLLOW_ONLY_EXPORTS` from the barrel — plus `NO_DISK_FOLLOW_EXPORTS` when `persists` is
 * `false`. One unknown name, or one statement with no names, and it restores — the answer every
 * realtime island had before; `persists` unknown keeps that answer. Pure: asked per build, of that
 * build's root. The blind spot is `reachesRealtime`'s own: a PACKAGE reading the store for the
 * island is not seen.
 */
export async function followsOnly(
  root: string,
  file: string,
  persists?: boolean,
): Promise<boolean> {
  const allowed =
    persists === false ? [...FOLLOW_ONLY_EXPORTS, ...NO_DISK_FOLLOW_EXPORTS] : FOLLOW_ONLY_EXPORTS;
  const restores = await firstInGraph(root, file, (source, path) => {
    const names = realtimeBindings(source, path);
    const follows = names?.every((name) => allowed.includes(name)) === true;
    return follows ? undefined : true;
  });
  return restores !== true;
}
