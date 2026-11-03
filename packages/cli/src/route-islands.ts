// Which islands one route render collects, and the realtime page boot that render earns. Split
// from `runtime-render.ts` so the document builder stays one job; both `documentFrom` and the
// `stream` branch read the same two answers.

// why: Bun ships no path API; an island's file is its route file's directory joined to its `src`.
import { posix } from 'node:path';
import type { IslandCollector, RouteEntry } from '@ultimat3/render';
import {
  clientBootTags,
  hydrateRuntime,
  islandCollector,
  islandModuleId,
  islandModuleIds,
  renderHead,
} from '@ultimat3/render';
import type { DocumentOptions } from './document-options';

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
      : { hold: (src: string) => restoresState(entry, options, src) }),
  });

/**
 * Whether `src`, as the page at `entry` wrote it, is an island the served bundle built as realtime
 * AND reading the record store or the outbox. An island that only follows the socket — a channel's
 * events, a roster, the connection — has no markup the restore could contradict, so hiding it
 * only delayed the page's content (`island-realtime-state.ts`).
 */
const restoresState = (entry: RouteEntry, options: DocumentOptions, src: string): boolean =>
  options.realtimeIslands?.().get(posix.join(posix.dirname(entry.file), src)) === 'restores';

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
  const reaches = [...(options.realtimeIslands?.().keys() ?? [])].some((file) => {
    const src = posix.relative(pageDir, file);
    return rendered.has(islandModuleId(src.startsWith('.') ? src : `./${src}`));
  });
  return reaches ? renderHead(clientBootTags(options.sync)) : '';
}

/** A stream document's boot and hydration scripts: its first flush's, and each hole chunk's. */
export interface StreamScripts {
  readonly first: string;
  /** For a hole's chunk, after its reveal: `''` while nothing it shows can hold an island. */
  readonly after: (outcome: 'filled' | 'failed') => string;
}

/**
 * An inline module waits for parsing to end, and a document with a hole open is still parsing, so
 * the runtime is `async` while nothing has to run before it. Once a boot is in the document it stays
 * deferred: the boot must run first (`bootScript`), at the cost a Known-Gaps row states.
 *
 * `after` re-runs the whole runtime once any hole recorded an island, rather than comparing against
 * what the last chunk took: holes record while running and reveal in completion order, so an island
 * recorded by a hole still open would otherwise be spent on another hole's chunk, before its root is
 * in the DOM. `each` visits a root once, so an extra run does nothing; every body is already hashed.
 * A FAILED hole shows its `error` markup, walked at shell time — so counted in `flushed` — yet not in
 * the DOM until this chunk: it re-runs whenever the page recorded any island at all.
 */
export function streamScripts(
  entry: RouteEntry,
  islands: IslandCollector,
  options: DocumentOptions,
  scope: string | undefined,
  holes: boolean,
): StreamScripts {
  const boot = bootScript(entry, islands, options, scope);
  const flushed = islands.directives.length;
  let booted = boot !== '';
  return {
    first: `${boot}${hydrateRuntime(islands.directives, { async: holes && !booted })}`,
    after: (outcome) => {
      const recorded = islands.directives.length;
      if (recorded === (outcome === 'failed' ? 0 : flushed)) return '';
      const late = booted ? '' : bootScript(entry, islands, options, scope);
      booted = booted || late !== '';
      return `${late}${hydrateRuntime(islands.directives, { async: !booted })}`;
    },
  };
}
