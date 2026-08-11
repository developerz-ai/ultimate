/**
 * The tree walker: a JSX node in, an HTML string out. It is the one place that knows what a
 * component call means on the server, so every render mode gets the same markup from the same
 * component — `static` at build time, `ssr`/`stream` per request, all through `renderToHtml`.
 */

import { PrerenderFailedError } from './errors';
import { escapeText, renderAttributes, VOID_ELEMENTS } from './html';
import type { JsxComponent, JsxProps } from './jsx';
import { isJsxNode } from './jsx';

/** Depth is bounded so a component that renders itself fails with a cause instead of a stack trace. */
const MAX_DEPTH = 500;

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * A thunk is called, not stringified. Solid's reactive reads are accessors (`count()`), and a
 * `children` prop is routinely a function — evaluating it once is exactly the server's job.
 */
async function unwrap(value: unknown, depth: number): Promise<string> {
  if (value === null || value === undefined || value === false || value === true) return '';
  if (typeof value === 'string') return escapeText(value);
  if (typeof value === 'number' || typeof value === 'bigint') return escapeText(String(value));
  if (value instanceof Promise) return unwrap(await value, depth);
  if (Array.isArray(value)) {
    const parts = await Promise.all(value.map((item) => unwrap(item, depth + 1)));
    return parts.join('');
  }
  if (isJsxNode(value)) return renderNode(value.type, value.props, depth);
  if (typeof value === 'function') return unwrap((value as () => unknown)(), depth + 1);
  return escapeText(String(value));
}

/**
 * `innerHTML` is the one escape hatch that emits unescaped markup, and it is deliberate: the
 * `<head>` renderers and the streaming reveal chunks are already-serialized HTML, and re-escaping
 * them would print the tags. Nothing else in this file trusts a string.
 */
async function renderElement(tag: string, props: JsxProps, depth: number): Promise<string> {
  const open = `<${tag}${renderAttributes(props)}>`;
  if (VOID_ELEMENTS.has(tag)) return open;
  const raw = (props as { innerHTML?: unknown }).innerHTML;
  const inner =
    raw === undefined || raw === null
      ? await unwrap((props as { children?: unknown }).children, depth + 1)
      : String(raw);
  return `${open}${inner}</${tag}>`;
}

async function renderNode(
  type: string | JsxComponent,
  props: JsxProps,
  depth: number,
): Promise<string> {
  if (depth > MAX_DEPTH) {
    throw new PrerenderFailedError(
      `component tree exceeded ${MAX_DEPTH} levels, so it renders itself`,
      'remove the self-reference from the component that renders its own tag',
    );
  }
  if (typeof type === 'string') return renderElement(type, props, depth);
  return unwrap(type(props), depth + 1);
}

/**
 * Render a component tree to HTML. Async throughout so a component may await its own data — the
 * `ssr` mode's whole point — without a second sync renderer existing beside this one.
 */
export async function renderToHtml(node: unknown): Promise<string> {
  return unwrap(node, 0);
}

/**
 * Render a route's page component, naming the file in the failure. A component that throws is a
 * build failure with a cause, never a blank body that looks like a routing problem.
 */
export async function renderComponent(
  component: JsxComponent,
  props: JsxProps,
  file: string,
): Promise<string> {
  try {
    return await renderToHtml(component(props));
  } catch (error) {
    if (error instanceof PrerenderFailedError) throw error;
    throw new PrerenderFailedError(
      `rendering the component in ${file} threw: ${describe(error)}`,
      `run \`bun test ${file.replace(/\.tsx?$/, '.test.ts')}\` to reproduce, then fix ${file}`,
    );
  }
}
