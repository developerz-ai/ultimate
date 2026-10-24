// TEST-ONLY. Calls a component and walks what it returned, so a test can assert on the props an
// element actually carries — the `tabindex`, the `aria-live`, the `onKeyDown`, the `ref` — rather
// than on a string it was serialised into. Complements `theme/inert-render.test.ts`, which asks
// the other question (does the markup come out at all).
//
// Every `.tsx` a test loads is compiled by `@ultimat3/render`'s loader, which the test preload
// installs before the first file: an element is the server factory's node, a `type`, a `props`,
// children under `props.children`. A tree a test builds by hand is `{ inert: true, type, props }`,
// the same shape, and this walker reads both. There is no classic-factory global any more: the
// `globalThis.React` this module installed was what Bun's own compile called through 1.4.2, and
// from 1.4.3 Bun's own compile never runs a test's `.tsx` at all (issue #883).

const RENDER_NODE: symbol = Symbol.for('ultimate.render.jsx');

export interface ProbeNode {
  readonly type: string | ((props: Record<string, unknown>) => unknown);
  readonly props: Record<string, unknown>;
}

export function isProbeNode(value: unknown): value is ProbeNode {
  if (typeof value !== 'object' || value === null) return false;
  return 'inert' in value || RENDER_NODE in value;
}

/**
 * Every host node in the tree, depth first, with nested components CALLED. Thunks are called too:
 * a component that reads a prop inside one renders nothing until something asks.
 */
export function nodesOf(value: unknown): ProbeNode[] {
  if (value === null || value === undefined || typeof value === 'boolean') return [];
  if (typeof value === 'string' || typeof value === 'number') return [];
  if (Array.isArray(value)) return value.flatMap(nodesOf);
  if (isProbeNode(value)) {
    if (typeof value.type === 'function') return nodesOf(value.type(value.props));
    return [value, ...nodesOf(value.props['children'])];
  }
  if (typeof value === 'function') return nodesOf((value as () => unknown)());
  return [];
}

/** Render a component to its host nodes. `props` is the component's own, untyped on purpose. */
export function renderNodes(component: unknown, props: Record<string, unknown> = {}): ProbeNode[] {
  return nodesOf((component as (p: Record<string, unknown>) => unknown)(props));
}

const attr = (node: ProbeNode, name: string): unknown => node.props[name];

/** Nodes whose attribute equals `value`; `undefined` matches "carries the attribute at all". */
export function withAttr(nodes: readonly ProbeNode[], name: string, value?: unknown): ProbeNode[] {
  return nodes.filter((node) =>
    value === undefined ? attr(node, name) !== undefined : attr(node, name) === value,
  );
}

export function byTag(nodes: readonly ProbeNode[], tag: string): ProbeNode[] {
  return nodes.filter((node) => node.type === tag);
}

/** The one node a test means, or a throw naming what it looked for — never a silent `undefined`. */
export function one(nodes: readonly ProbeNode[], what: string): ProbeNode {
  const node = nodes[0];
  if (node === undefined || nodes.length !== 1) {
    throw new Error(`expected exactly one ${what}, found ${nodes.length}`);
  }
  return node;
}

/** Call an element's `ref` prop with the element a test built for it. */
export function attachRef(node: ProbeNode, element: unknown): void {
  const ref = node.props['ref'];
  if (typeof ref !== 'function') throw new Error(`node <${String(node.type)}> carries no ref`);
  (ref as (el: unknown) => void)(element);
}

/** Call an element's event handler prop, e.g. `fire(menu, 'onKeyDown', keydown('ArrowDown'))`. */
export function fire(node: ProbeNode, handler: string, event: unknown): void {
  const fn = node.props[handler];
  if (typeof fn !== 'function')
    throw new Error(`node <${String(node.type)}> carries no ${handler}`);
  (fn as (e: unknown) => void)(event);
}
