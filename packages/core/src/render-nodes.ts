// A component's node tree, walked so a test can assert on the props an element carries (the
// `aria-live`, the `onKeyDown`, the `ref`) rather than on markup it was serialised into. Reads the
// render factory's branded node and a hand-built `{ inert: true }` one; needs nothing from
// `@ultimat3/render`, so it sits at tier 0 behind `@ultimat3/core/render-nodes`, off the barrel.

import { assert } from './assert';
import { HOLE_NODE, ISLAND_NODE, JSX_NODE } from './render-node';

export type RenderComponent = (props: Record<string, unknown>) => unknown;

export interface RenderNode {
  /** A lowercase string is an element; a function is a component. */
  readonly type: string | RenderComponent;
  readonly props: Record<string, unknown>;
}

/**
 * What a walk does at a component node. `expand` calls it and keeps only host nodes; `keep` calls
 * it and keeps the component node too, so a test can read the props a view handed a design-system
 * component; `stop` keeps the node, never calls it, and walks the children it was handed.
 */
export type ComponentMode = 'expand' | 'keep' | 'stop';

export interface NodesOfOptions {
  readonly components?: ComponentMode | undefined;
}

export function isRenderNode(value: unknown): value is RenderNode {
  if (typeof value !== 'object' || value === null) return false;
  return 'inert' in value || JSX_NODE in value;
}

/**
 * Every node in the tree, depth first. Thunks are called: a component that reads a prop inside one
 * renders nothing until something asks. A value no factory built contributes nothing.
 */
export function nodesOf(value: unknown, options: NodesOfOptions = {}): RenderNode[] {
  return walk(value, options.components ?? 'expand');
}

type BrandedProps = { readonly props?: Record<string, unknown> };

/**
 * An island or a hole is an ARRAY to the type system, so each is tested before the array branch,
 * which would walk nothing. An island's subtree is its server shell, `props.children`. A hole's
 * first flush is `fallback` and `error`; its `children` are deferred work, never called here.
 */
const isIsland = (value: unknown): value is BrandedProps =>
  typeof value === 'object' && value !== null && ISLAND_NODE in value;
const isHole = (value: unknown): value is BrandedProps =>
  typeof value === 'object' && value !== null && HOLE_NODE in value;

function walk(value: unknown, mode: ComponentMode): RenderNode[] {
  if (isIsland(value)) return walk(value.props?.['children'], mode);
  if (isHole(value)) return walk([value.props?.['fallback'], value.props?.['error']], mode);
  if (Array.isArray(value)) return value.flatMap((item) => walk(item, mode));
  if (isRenderNode(value)) {
    const { type, props } = value;
    if (typeof type !== 'function' || mode === 'stop')
      return [value, ...walk(props['children'], mode)];
    const output = walk(type(props), mode);
    return mode === 'keep' ? [value, ...output] : output;
  }
  if (typeof value === 'function') return walk((value as () => unknown)(), mode);
  return [];
}

/** Render a component to its nodes. `props` is the component's own, untyped on purpose. */
export function renderNodes(
  component: unknown,
  props: Record<string, unknown> = {},
  options: NodesOfOptions = {},
): RenderNode[] {
  assert(
    typeof component === 'function',
    'renderNodes() was handed a value that is not a component function',
    'renderNodes(Button, { label: "Save" }) — the component function itself, never <Button /> or its output',
  );
  return nodesOf((component as RenderComponent)(props), options);
}

export function byTag(nodes: readonly RenderNode[], tag: string): RenderNode[] {
  return nodes.filter((node) => node.type === tag);
}

/** Nodes rendered by the named component, read off its function name: `byComponent(n, 'Money')`. */
export function byComponent(nodes: readonly RenderNode[], name: string): RenderNode[] {
  return nodes.filter((node) => typeof node.type === 'function' && node.type.name === name);
}

/** Nodes whose attribute equals `value`; `undefined` matches "carries the attribute at all". */
export function withAttr(
  nodes: readonly RenderNode[],
  name: string,
  value?: unknown,
): RenderNode[] {
  return nodes.filter((node) =>
    value === undefined ? node.props[name] !== undefined : node.props[name] === value,
  );
}

/** The one node a test means, or `X_INVARIANT` naming what it sought — never a silent `undefined`. */
export function one(nodes: readonly RenderNode[], what: string): RenderNode {
  const node = nodes[0];
  assert(
    node !== undefined && nodes.length === 1,
    `expected exactly one ${what}, found ${nodes.length}`,
    'one(withAttr(byTag(nodes, "button"), "aria-label", "Save"), "the save button") — narrow until one node matches',
  );
  return node;
}

/** `<button>` for an element, `<Money>` for a component: never a function's source text. */
const label = (node: RenderNode): string =>
  `<${typeof node.type === 'function' ? node.type.name : node.type}>`;

/** Call an element's `ref` prop with the element a test built for it. */
export function attachRef(node: RenderNode, element: unknown): void {
  const ref = node.props['ref'];
  assert(
    typeof ref === 'function',
    `node ${label(node)} carries no ref`,
    'attachRef(one(withAttr(nodes, "ref"), "the node holding a ref"), element) — pick the node that declares ref={…}',
  );
  (ref as (el: unknown) => void)(element);
}

/** Call an element's event handler prop, e.g. `fire(menu, 'onKeyDown', keydown('ArrowDown'))`. */
export function fire(node: RenderNode, handler: string, event: unknown): void {
  const fn = node.props[handler];
  assert(
    typeof fn === 'function',
    `node ${label(node)} carries no ${handler}`,
    `fire(one(withAttr(nodes, "${handler}"), "the node holding ${handler}"), "${handler}", event) — pick the node that declares it`,
  );
  (fn as (e: unknown) => void)(event);
}
