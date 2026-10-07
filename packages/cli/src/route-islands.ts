// Which islands one route render collects, and the realtime page boot that render earns. Split
// from `runtime-render.ts` so the document builder stays one job; both `documentFrom` and the
// `stream` branch read the same two answers.

// why: Bun ships no path API; an island's file is its route file's directory joined to its `src`.
import { posix } from 'node:path';
import type { IslandCollector, RouteEntry } from '@ultimat3/render';
import {
  clientBootTags,
  islandCollector,
  islandModuleId,
  islandModuleIds,
  renderHead,
} from '@ultimat3/render';
import type { DocumentOptions } from './document-options';
import { realtimeIslandFiles } from './island-realtime';

/**
 * One collector per RENDER, never module-global: two requests render different params, and a
 * shared collector would bill one page for the other's islands. `hydrate` comes off the route, so
 * an island never declares its own timing, and `resolve` is the build's — identity when nothing
 * built any, which fails at the first island by name rather than emitting an unusable entry.
 */
export const collectorFor = (
  entry: RouteEntry,
  options: DocumentOptions,
  scope: string | undefined,
): IslandCollector =>
  islandCollector({
    file: entry.file,
    hydrate: entry.config.hydrate,
    ...(options.resolveIsland === undefined ? {} : { resolve: options.resolveIsland(entry.file) }),
    // #506: on a document that carries the page boot (the same two conditions as `bootScript`), a
    // realtime island's server markup is held off screen until it mounts over the restored store.
    ...(scope === undefined || options.sync === undefined
      ? {}
      : { hold: (src: string) => reachesRealtime(entry, src) }),
  });

/** Whether `src`, as the page at `entry` wrote it, is an island the last build found realtime. */
const reachesRealtime = (entry: RouteEntry, src: string): boolean =>
  realtimeIslandFiles().has(posix.join(posix.dirname(entry.file), src));

/**
 * Realtime's page boot, as one deferred script — or nothing. Two conditions, both exact: the
 * document carries a principal scope (restoring persisted records and replaying queued writes are
 * per principal; a shareable document has neither), AND one of the islands this render emitted
 * reaches `@ultimat3/realtime` (a page whose islands never touch a record has nothing to restore
 * into and no write to replay). After the body, because which islands rendered is a fact the walk
 * just recorded; still before the hydration runtime, so it runs first among the deferred scripts.
 */
export function bootScript(
  entry: RouteEntry,
  islands: IslandCollector,
  options: DocumentOptions,
  scope: string | undefined,
): string {
  if (scope === undefined || options.sync === undefined) return '';
  const rendered = new Set(islandModuleIds(islands.directives));
  if (rendered.size === 0) return '';
  // An island's module id is derived from its `src`, written relative to the page that renders it:
  // each realtime island file, spelled from THIS page, is the id its directive would carry.
  const pageDir = posix.dirname(entry.file);
  const reaches = [...realtimeIslandFiles()].some((file) => {
    const src = posix.relative(pageDir, file);
    return rendered.has(islandModuleId(src.startsWith('.') ? src : `./${src}`));
  });
  return reaches ? renderHead(clientBootTags(options.sync)) : '';
}
