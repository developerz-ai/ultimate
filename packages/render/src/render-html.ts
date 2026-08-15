/**
 * The tree walker: a JSX node in, an HTML string out. It is the one place that knows what a
 * component call means on the server, so every render mode gets the same markup from the same
 * component — `static` at build time, `ssr`/`stream` per request, all through `renderToHtml`.
 */

import {
  IslandInvalidError,
  IslandNotHydratedError,
  IslandPropsInvalidError,
  PrerenderFailedError,
} from './errors';
import { escapeText, renderAttributes, VOID_ELEMENTS } from './html';
import { emitIslandAttributes, emitIslandProps } from './hydrate';
import type { IslandNode } from './island';
import { isIslandNode } from './island';
import type { IslandCollector } from './island-collector';
import { islandWithoutCollector } from './island-collector';
import type { JsxComponent, JsxProps } from './jsx';
import { isJsxNode } from './jsx';

/** Depth is bounded so a component that renders itself fails with a cause instead of a stack trace. */
const MAX_DEPTH = 500;

/**
 * What the walk carries besides depth. One object per render, never module-global: two concurrent
 * requests render different params, and a shared collector would bill one page for the other's JS.
 */
export interface RenderHtmlOptions {
  readonly islands?: IslandCollector;
}

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * A thunk is called, not stringified. Solid's reactive reads are accessors (`count()`), and a
 * `children` prop is routinely a function — evaluating it once is exactly the server's job.
 */
async function unwrap(value: unknown, depth: number, walk: RenderHtmlOptions): Promise<string> {
  if (value === null || value === undefined || value === false || value === true) return '';
  if (typeof value === 'string') return escapeText(value);
  if (typeof value === 'number' || typeof value === 'bigint') return escapeText(String(value));
  if (value instanceof Promise) return unwrap(await value, depth, walk);
  // Before the array branch, never after: an island node IS an array — the only object shape the
  // configured `JSX.Element` admits — so the generic branch would render its empty contents and
  // drop the island, its props script and its budget line without a word.
  if (isIslandNode(value)) return renderIsland(value, depth, walk);
  if (Array.isArray(value)) {
    const parts = await Promise.all(value.map((item) => unwrap(item, depth + 1, walk)));
    return parts.join('');
  }
  if (isJsxNode(value)) return renderNode(value.type, value.props, depth, walk);
  if (typeof value === 'function') return unwrap((value as () => unknown)(), depth + 1, walk);
  return escapeText(String(value));
}

/**
 * `innerHTML` is the one escape hatch that emits unescaped markup, and it is deliberate: the
 * `<head>` renderers and the streaming reveal chunks are already-serialized HTML, and re-escaping
 * them would print the tags. Nothing else in this file trusts a string.
 */
async function renderElement(
  tag: string,
  props: JsxProps,
  depth: number,
  walk: RenderHtmlOptions,
): Promise<string> {
  const open = `<${tag}${renderAttributes(props)}>`;
  if (VOID_ELEMENTS.has(tag)) return open;
  const raw = (props as { innerHTML?: unknown }).innerHTML;
  const inner =
    raw === undefined || raw === null
      ? await unwrap((props as { children?: unknown }).children, depth + 1, walk)
      : String(raw);
  return `${open}${inner}</${tag}>`;
}

/**
 * An island renders its SHELL on the server — the children the page wrote — and nothing of the
 * client module: the specifier is data, so there is no import to follow and the static page's
 * bundle graph never grows. The props script travels inside the wrapper so a document assembler
 * has exactly one thing left to remember, the runtime.
 */
async function renderIsland(
  node: IslandNode,
  depth: number,
  walk: RenderHtmlOptions,
): Promise<string> {
  const collector = walk.islands;
  if (collector === undefined) throw islandWithoutCollector(node.spec);
  const directive = collector.record(node.spec, node.props);
  const shell = await unwrap((node.props as { children?: unknown }).children, depth + 1, walk);
  const tag = node.spec.tag;
  return `<${tag} ${emitIslandAttributes(directive)}>${shell}${emitIslandProps(directive)}</${tag}>`;
}

async function renderNode(
  type: string | JsxComponent,
  props: JsxProps,
  depth: number,
  walk: RenderHtmlOptions,
): Promise<string> {
  if (depth > MAX_DEPTH) {
    throw new PrerenderFailedError(
      `component tree exceeded ${MAX_DEPTH} levels, so it renders itself`,
      'remove the self-reference from the component that renders its own tag',
    );
  }
  if (typeof type === 'string') return renderElement(type, props, depth, walk);
  return unwrap(type(props), depth + 1, walk);
}

/**
 * Render a component tree to HTML. Async throughout so a component may await its own data — the
 * `ssr` mode's whole point — without a second sync renderer existing beside this one.
 */
export async function renderToHtml(
  node: unknown,
  options: RenderHtmlOptions = {},
): Promise<string> {
  return unwrap(node, 0, options);
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
      `rendering the component in ${file} threw: ${describe(error)}`,
      `run \`bun test ${file.replace(/\.tsx?$/, '.test.ts')}\` to reproduce, then fix ${file}`,
    );
  }
}
