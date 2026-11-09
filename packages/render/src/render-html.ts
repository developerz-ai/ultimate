/**
 * Rendering a component tree: the options one render carries, its hole sink, and the two entry
 * points. Every render mode gets the same markup from the same component — `static` at build
 * time, `ssr`/`stream` per request — because all of them come through `renderToHtml`.
 */

import { renderFixShellArg, renderThrowable } from '@ultimat3/core';
import {
  IslandInvalidError,
  IslandNotHydratedError,
  IslandPropsInvalidError,
  PrerenderFailedError,
} from './errors';
import type { IslandCollector } from './island-collector';
import type { JsxComponent, JsxProps } from './jsx';
import { instrumentedHoles, routeOfFile, timedRender } from './render-instrument';
import type { StreamHole } from './render-stream';
import { renderAlone } from './render-walk';

/**
 * The id of the element every document wraps its route component in — one name, because a service
 * worker, a test and a client entry all address the same element. It was `SPA_ROOT_ID` in
 * `render-spa.ts` and named a mode that no longer exists, while every mode has always used it.
 */
export const ROOT_ELEMENT_ID = 'x-root';

/**
 * What the walk carries besides depth. One object per render, never module-global: two concurrent
 * requests render different params, and a shared collector would bill one page for the other's JS.
 */
export interface RenderHtmlOptions {
  readonly islands?: IslandCollector;
  /**
   * Where a `<Hole>` goes instead of being awaited. Only the `stream` branch passes one: every
   * other render has one flush, so a hole there is its children, inline, and is weighed.
   */
  readonly holes?: HoleSink;
}

/** One render's holes, and the counter their ids come from. Per render, as the collector is. */
export interface HoleSink {
  readonly holes: readonly StreamHole[];
  /** The next id, taken before the walk awaits anything so ids follow the tree. */
  nextId(): string;
  add(hole: StreamHole): void;
  /** Runs a hole's children under its signal: the host's seam for what is ambient inside one. */
  readonly enter: HoleEnter;
}

/**
 * How a host runs a hole's children: given the hole's signal (aborted at its deadline and on a
 * client disconnect; a hole that settled keeps it un-aborted), in whatever scope it builds. The CLI makes that signal
 * the ambient one and refuses response headers after the flush; render knows neither.
 */
export type HoleEnter = (signal: AbortSignal, run: () => Promise<string>) => Promise<string>;

export interface HoleSinkOptions {
  readonly enter?: HoleEnter;
}

export function holeSink(options: HoleSinkOptions = {}): HoleSink {
  const holes: StreamHole[] = [];
  let last = 0;
  return {
    holes,
    enter: options.enter ?? ((_signal, run) => run()),
    nextId() {
      last += 1;
      return String(last);
    },
    add(hole) {
      holes.push(hole);
    },
  };
}

/**
 * Render a component tree to HTML. Always a promise so a component may await its own data — the
 * `ssr` mode's whole point — while the walk itself (`render-walk.ts`) stays synchronous until the
 * tree holds something to await: one walker, never a second sync renderer beside it.
 */
export async function renderToHtml(
  node: unknown,
  options: RenderHtmlOptions = {},
): Promise<string> {
  return renderAlone(node, 0, options);
}

/**
 * Render a route's page component, naming the file in the failure. A component that throws is a
 * build failure with a cause, never a blank body that looks like a routing problem.
 */
export async function renderComponent(
  component: JsxComponent,
  props: JsxProps,
  file: string,
  options: RenderHtmlOptions = {},
): Promise<string> {
  // Reported AS the caller sees it: the coded failure below, never the raw throw it wraps.
  const route = routeOfFile(file);
  const walk =
    options.holes === undefined
      ? options
      : { ...options, holes: instrumentedHoles(options.holes, route) };
  return timedRender('render.page', { route }, () => renderPage(component, props, file, walk));
}

async function renderPage(
  component: JsxComponent,
  props: JsxProps,
  file: string,
  options: RenderHtmlOptions,
): Promise<string> {
  try {
    return await renderToHtml(component(props), options);
  } catch (error) {
    // An island failure already names the file, the prop and the edit. Wrapping it would replace
    // three stable codes with one that says only "the component threw".
    if (error instanceof PrerenderFailedError) throw error;
    if (error instanceof IslandInvalidError) throw error;
    if (error instanceof IslandPropsInvalidError) throw error;
    if (error instanceof IslandNotHydratedError) throw error;
    throw new PrerenderFailedError(
      // `renderThrowable`, never `.message`/`String()`: a component is app code and may throw a
      // null-prototype object (`String()` raises) or an Error whose `message` getter does — and
      // this frame is the last thing between that and a build failure with no code at all.
      `rendering the component in ${file} threw: ${renderThrowable(error)}`,
      // The route file is author text and `$(…)` is a legal name: screened where it enters the
      // reproduce command (security audit of plan 101 sweep 1c).
      `run \`bun test ${renderFixShellArg(file.replace(/\.tsx?$/, '.test.ts'), "'<the route's test file>'")}\` to reproduce, then fix ${file}`,
    );
  }
}
