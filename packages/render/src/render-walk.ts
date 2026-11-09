/**
 * The tree walker: a JSX node in, HTML pieces out, appended to one flat buffer per render. A
 * subtree pays for a promise only where it holds one — an awaited component, a `<Hole>` shell —
 * so a 50k-row table is one synchronous pass and one `join` (plan 101 slice 14 P1).
 */

import { escapeHtml } from '@ultimat3/core';
import { JSX_NODE } from '@ultimat3/core/render-node';
import { PrerenderFailedError } from './errors';
import type { HoleNode } from './hole';
import { isHoleNode } from './hole';
import { renderAttributes, VOID_ELEMENTS } from './html';
import { emitIslandAttributes, emitIslandProps } from './hydrate';
import type { IslandNode } from './island';
import { isIslandNode } from './island';
import { islandWithoutCollector } from './island-collector';
import type { JsxNode, JsxProps } from './jsx';
import type { RenderHtmlOptions } from './render-html';
import { holeMarker } from './render-stream';

/** Depth is bounded so a component that renders itself fails with a cause instead of a stack trace. */
const MAX_DEPTH = 500;

/**
 * Asserted on every recursion, not only the element path: `children` is routinely an array or a
 * thunk, and a self-referencing one escaped as a bare `RangeError` with no code and no `fix:`.
 */
function assertDepth(depth: number): void {
  if (depth <= MAX_DEPTH) return;
  throw new PrerenderFailedError(
    `component tree exceeded ${MAX_DEPTH} levels, so it renders itself`,
    'remove the self-reference from the component that renders its own tag',
  );
}

/** What a subtree renders to: the string while it stayed synchronous, a promise once it awaited. */
export type Rendered = string | Promise<string>;

/**
 * One render's output, in tree order. A pending subtree is a slot; everything else is a string.
 * Side effects (a component call, an island's `record`, a hole's id) therefore run in tree order:
 * every sibling's synchronous prefix runs before anything awaits, exactly as the all-async walker
 * this replaced ran them.
 */
interface Buffer {
  /** Everything since the last slot. `+=` builds a rope; it is flattened once, when read. */
  html: string;
  /** Text before each pending slot, then the slot; absent while the render is synchronous. */
  parts: Rendered[] | undefined;
}

const noop = (): void => undefined;

/**
 * Renders `value` into a buffer of its own and settles it. A synchronous throw leaves the slots
 * already started unobserved, so each is marked handled before the throw goes on: the old
 * `Promise.all` observed every sibling, and an unhandled rejection kills a Bun process.
 */
export function renderAlone(value: unknown, depth: number, walk: RenderHtmlOptions): Rendered {
  const out: Buffer = { html: '', parts: undefined };
  try {
    emit(value, depth, walk, out);
  } catch (error) {
    for (const part of out.parts ?? []) if (typeof part !== 'string') part.catch(noop);
    throw error;
  }
  if (out.parts === undefined) return out.html;
  out.parts.push(out.html);
  return Promise.all(out.parts).then((done) => done.join(''));
}

function slot(out: Buffer, pending: Promise<string>): void {
  out.parts ??= [];
  out.parts.push(out.html, pending);
  out.html = '';
}

/**
 * A thunk is called, not stringified: Solid's reactive reads are accessors (`count()`), and a
 * `children` prop is routinely a function — evaluating it once is exactly the server's job.
 */
function emit(value: unknown, depth: number, walk: RenderHtmlOptions, out: Buffer): void {
  assertDepth(depth);
  if (value === null || value === undefined || value === false || value === true) return;
  if (typeof value === 'string') {
    out.html += escapeHtml(value);
    return;
  }
  // A number's spelling is digits, `-`, `.`, `e`, `+`, `Infinity` or `NaN`: nothing to escape.
  if (typeof value === 'number' || typeof value === 'bigint') {
    out.html += String(value);
    return;
  }
  if (typeof value === 'function') {
    emit((value as () => unknown)(), depth + 1, walk, out);
    return;
  }
  if (typeof value !== 'object') {
    out.html += escapeHtml(String(value));
    return;
  }
  // The common case first. An island or hole node never carries `JSX_NODE`, so testing it before
  // them changes no answer — only the arrays below must be told apart from those two.
  if (JSX_NODE in value) {
    emitNode(value as JsxNode, depth, walk, out);
    return;
  }
  if (value instanceof Promise) {
    slot(
      out,
      value.then((settled) => renderAlone(settled, depth, walk)),
    );
    return;
  }
  // Before the array branch, never after: an island node IS an array — the only object shape the
  // configured `JSX.Element` admits — so the generic branch would drop the island, its props
  // script and its budget line without a word.
  if (isIslandNode(value)) {
    emitIsland(value, depth, walk, out);
    return;
  }
  if (isHoleNode(value)) {
    emitHole(value, depth, walk, out);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) emit(item, depth + 1, walk, out);
    return;
  }
  out.html += escapeHtml(String(value));
}

/**
 * `innerHTML` is the one escape hatch that emits unescaped markup, and it is deliberate: the
 * `<head>` renderers and the streaming reveal chunks are already-serialized HTML, and re-escaping
 * them would print the tags. Nothing else in the walk trusts a string.
 */
function emitNode(node: JsxNode, depth: number, walk: RenderHtmlOptions, out: Buffer): void {
  const { type, props } = node;
  if (typeof type !== 'string') {
    emit(type(props), depth + 1, walk, out);
    return;
  }
  out.html += `<${type}${renderAttributes(props)}>`;
  if (VOID_ELEMENTS.has(type)) return;
  const raw = (props as { innerHTML?: unknown }).innerHTML;
  if (raw === undefined || raw === null) {
    emit((props as { children?: unknown }).children, depth + 1, walk, out);
  } else out.html += String(raw);
  out.html += `</${type}>`;
}

/**
 * An island renders its SHELL on the server — the children the page wrote — and nothing of the
 * client module: the specifier is data, so there is no import to follow and the static page's
 * bundle graph never grows. The props script travels inside the wrapper.
 */
function emitIsland(node: IslandNode, depth: number, walk: RenderHtmlOptions, out: Buffer): void {
  const collector = walk.islands;
  if (collector === undefined) throw islandWithoutCollector(node.spec);
  const directive = collector.record(node.spec, node.props);
  const tag = node.spec.tag;
  out.html += `<${tag} ${emitIslandAttributes(directive)}>`;
  emit((node.props as { children?: unknown }).children, depth + 1, walk, out);
  out.html += `${emitIslandProps(directive)}</${tag}>`;
}

/**
 * A promise already running when the tree was built is awaited only once the stream starts, after
 * the fallback rendered; a rejection before then is unhandled. Marked through arrays and JSX
 * children — never by calling a thunk or a component, which have not run — and the hole still
 * awaits and sees it. `seen` stops a self-referencing array.
 */
function observeEagerPromises(value: unknown, seen: Set<object>): void {
  if (value instanceof Promise) {
    value.catch(noop);
    return;
  }
  if (typeof value !== 'object' || value === null || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) for (const item of value) observeEagerPromises(item, seen);
  // An island or hole node is an array whose own items are empty: its tree is in `props`.
  if (JSX_NODE in value || isIslandNode(value) || isHoleNode(value)) {
    const props = (value as { props: JsxProps }).props as {
      children?: unknown;
      fallback?: unknown;
      error?: unknown;
    };
    observeEagerPromises(props.children, seen);
    observeEagerPromises(props.fallback, seen);
    observeEagerPromises(props.error, seen);
  }
}

/**
 * Everything under a hole walks with no sink: a nested hole is inline inside the outer one, since
 * the set of pending holes is fixed at the first flush (`renderStreamHtml`). `resolve` is a thunk,
 * so `children` start inside `start()`, in the request's async context, after the shell is out.
 */
function emitHole(node: HoleNode, depth: number, walk: RenderHtmlOptions, out: Buffer): void {
  const sink = walk.holes;
  const inner: RenderHtmlOptions = walk.islands === undefined ? {} : { islands: walk.islands };
  const { children, error, fallback } = node.props;
  if (sink === undefined) {
    emit(children, depth + 1, inner, out);
    return;
  }
  const id = sink.nextId();
  observeEagerPromises(children, new Set());
  const shown = renderAlone(fallback, depth + 1, inner);
  let failed: Rendered | undefined;
  try {
    failed = error === undefined ? undefined : renderAlone(error, depth + 1, inner);
  } catch (thrown) {
    if (typeof shown !== 'string') shown.catch(noop);
    throw thrown;
  }
  const settle = (fallbackHtml: string, errorHtml: string | undefined): string => {
    sink.add({
      id,
      fallback: fallbackHtml,
      ...(errorHtml === undefined ? {} : { error: errorHtml }),
      resolve: (signal) => sink.enter(signal, async () => renderAlone(children, depth + 1, inner)),
    });
    return holeMarker(id, fallbackHtml);
  };
  if (typeof shown === 'string' && typeof failed !== 'object') {
    out.html += settle(shown, failed);
    return;
  }
  slot(
    out,
    Promise.all([shown, failed]).then(([fallbackHtml, errorHtml]) =>
      settle(fallbackHtml, errorHtml),
    ),
  );
}
