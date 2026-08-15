/**
 * What one render pulled in. The collector is where an island's timing, its budget and its
 * failure to have either come from the ROUTE rather than from the island — so `hydrate` stays the
 * one place a route says it ships JavaScript, and the directives stay a per-render fact.
 */

import { IslandInvalidError, IslandNotHydratedError } from './errors';
import type { IslandDirective } from './hydrate';
import { DEFAULT_REPLAY_EVENTS } from './hydrate';
import type { IslandSpec } from './island';
import { isEmittableSpecifier } from './island';
import type { IslandProps } from './island-props';
import { checkIslandProps } from './island-props';
import type { JsxProps } from './jsx';
import type { HydrateStrategy } from './route';

/** The distinct client entries a rendered page pulled in — one per module, however many instances. */
export function islandModuleIds(directives: readonly IslandDirective[]): readonly string[] {
  const ids = new Set<string>();
  for (const directive of directives) ids.add(directive.moduleId ?? directive.islandId);
  return [...ids];
}

export interface IslandCollectorInput {
  /** The route file, so every failure names the file an author has to open. */
  readonly file: string;
  /** The route's `hydrate`. The island inherits it; it never declares one of its own. */
  readonly hydrate: HydrateStrategy;
  /** Specifier → built chunk URL. Identity in dev and in tests; the build supplies the real one. */
  readonly resolve?: (src: string) => string;
}

/**
 * Collects what a single render pulled in. Per render, never module-global: two requests render
 * different params and a shared collector would bill one page for the other's islands.
 */
export interface IslandCollector {
  readonly file: string;
  readonly hydrate: HydrateStrategy;
  readonly directives: readonly IslandDirective[];
  /** Called by the tree walker once per island instance. Returns what the markup is built from. */
  record(spec: IslandSpec, props: JsxProps): IslandDirective;
}

export function createIslandCollector(input: IslandCollectorInput): IslandCollector {
  const directives: IslandDirective[] = [];
  const entries = new Map<string, string>();
  const resolve = input.resolve ?? ((src: string) => src);
  const strategy = input.hydrate;

  return {
    file: input.file,
    hydrate: strategy,
    get directives(): readonly IslandDirective[] {
      return directives;
    },
    record(spec: IslandSpec, props: JsxProps): IslandDirective {
      assertHydrates(strategy, spec, input.file);

      const entry = resolve(spec.src);
      assertEntry(entry, spec, input.file);
      const claimed = entries.get(spec.moduleId);
      if (claimed !== undefined && claimed !== entry) {
        throw new IslandInvalidError(
          `two islands on ${input.file} both resolve to the id ${spec.moduleId} (${claimed} and ` +
            `${entry}), so their props would be handed to whichever the browser found first`,
          `rename one of the modules — the id is its filename, so two islands need two names`,
        );
      }
      entries.set(spec.moduleId, entry);

      const bag = checkIslandProps(props, spec.propKeys, input.file, spec.moduleId);
      const instance = directives.filter((d) => d.moduleId === spec.moduleId).length + 1;
      const directive = buildDirective(spec, strategy, entry, `${spec.moduleId}-${instance}`, bag);
      directives.push(directive);
      return directive;
    },
  };
}

function buildDirective(
  spec: IslandSpec,
  strategy: HydrateStrategy,
  entry: string,
  islandId: string,
  props: IslandProps,
): IslandDirective {
  // Replay defaults to every event a shell can receive: losing the first keystroke in a search box
  // is the same failure as losing the first click, and only the declaration knows which shell it is.
  const events = strategy === 'interaction' ? (spec.events ?? DEFAULT_REPLAY_EVENTS) : spec.events;
  return {
    islandId,
    moduleId: spec.moduleId,
    strategy,
    entry,
    ...(Object.keys(props).length === 0 ? {} : { props }),
    ...(events === undefined ? {} : { events }),
    ...(spec.rootMargin === undefined ? {} : { rootMargin: spec.rootMargin }),
  };
}

/**
 * An island on a route that ships no JS is a button that does nothing — and it is also how the
 * budget stops meaning anything, because `hydrate: 'never'` is what excuses a `site/` route from
 * declaring `budget.js` at all.
 */
function assertHydrates(strategy: HydrateStrategy, spec: IslandSpec, file: string): void {
  if (strategy !== 'never') return;
  throw new IslandNotHydratedError(
    `${file} renders the ${spec.moduleId} island but declares hydrate: 'never', so the browser ` +
      'would receive its markup and never the JavaScript that makes it do anything',
    `set hydrate: 'interaction' (or 'idle' | 'visible') and budget: { js: '10kb' } in ${file}, ` +
      `or remove <${spec.moduleId}> from the page`,
  );
}

function assertEntry(entry: string, spec: IslandSpec, file: string): void {
  if (isEmittableSpecifier(entry)) return;
  throw new IslandInvalidError(
    `the resolver returned ${JSON.stringify(entry)} for the ${spec.moduleId} island in ${file}, ` +
      'which cannot be emitted as a module URL',
    'fix the resolve() passed to createIslandCollector — it must return a plain URL path',
  );
}

/** Thrown from the walker when an island is rendered with nothing to boot it. */
export function islandWithoutCollector(spec: IslandSpec): IslandNotHydratedError {
  return new IslandNotHydratedError(
    `the ${spec.moduleId} island was rendered outside a render that collects islands, so no ` +
      'hydration runtime is emitted and its chunk is never requested',
    'render the page through renderToHtml(tree, { islands: createIslandCollector({ file, ' +
      'hydrate }) }) so the island is counted, booted and budgeted',
  );
}
