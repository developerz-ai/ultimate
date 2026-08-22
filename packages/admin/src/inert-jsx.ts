// TEST-ONLY. Calls an admin `.tsx` view as the plain function it is and walks what came back, so
// a test can assert on the tree a screen produced rather than on a value it also constructed.
//
// Which JSX factory a `.tsx` in this package compiled to is NOT ours to choose: `@ultimat3/render`
// installs a process-global `Bun.plugin` `onLoad` for `/\.tsx$/` at import (`routes.ts` imports it,
// so any sibling suite can win the race) and `bun test` is one process. Both factories build the
// same shape — a `type`, a `props`, children under `props.children` — so this walker recognises
// both and the run's file order stops deciding. Recognising neither is what falls through to
// `String(value)` and asserts against `"[object Object]"`.

// The subpath, never the barrel: this is a test harness and the design system's `index.ts` is its
// semver'd contract (`packages/ui/CLAUDE.md`). It is imported for `globalThis.React`'s ONE counter.
import { probe, unprobe } from '@ultimat3/ui/jsx-probe';

/** `@ultimat3/render`'s node brand, read off the GLOBAL symbol registry rather than imported. */
const RENDER_NODE: symbol = Symbol.for('ultimate.render.jsx');

export type InertComponent = (props: Record<string, unknown>) => unknown;

export interface InertNode {
  readonly type: string | InertComponent;
  readonly props: Record<string, unknown>;
}

export function isInertNode(value: unknown): value is InertNode {
  if (typeof value !== 'object' || value === null) return false;
  return 'inert' in value || RENDER_NODE in value;
}

/**
 * Build a node by hand, the shape the installed factory builds. NOT the installed factory — that is
 * `@ultimat3/ui`'s, so there is one owner of `globalThis.React` (see `installFactory` below). This
 * is what a test uses to construct a tree it did not render.
 */
export function h(
  type: string | InertComponent,
  props: Record<string, unknown> | null,
  ...children: readonly unknown[]
): InertNode {
  const base = { ...(props ?? {}) };
  if (children.length > 0) base['children'] = children.length === 1 ? children[0] : children;
  return { inert: true, type, props: base } as unknown as InertNode;
}

/**
 * Install the classic-factory global, through `@ultimat3/ui`'s ONE counter over `globalThis.React`.
 *
 * This package kept its own `depth`/`saved` pair until 2026-08-22, and two counters over one
 * property restore in the wrong order: admin installs (saving the real binding), ui installs
 * (saving ADMIN's factory), admin restores (its counter hits 0 → the real binding is back), ui
 * restores (its counter hits 0 → admin's factory goes back over it). `bun test` is one process and
 * `packages/ui` and `packages/admin` are one run, so the interleave is reachable, and the global
 * was left holding a harness the run had already torn down. `admin` is tier 5 and `ui` is tier 4,
 * so importing down is the fix; the two factories build the same `{ inert, type, props }` shape,
 * which is what `isInertNode` recognises.
 */
export function installFactory(): void {
  probe();
}

/** Undo the matching `installFactory()`. Unbalanced calls are inert. */
export function restoreFactory(): void {
  unprobe();
}

/**
 * Every node in the tree, depth first, with nested components CALLED and thunks invoked — a
 * component that reads a prop inside one renders nothing until something asks.
 *
 * Component nodes are KEPT as well as expanded, so a test can assert on the props a view handed
 * `<Money>` — the admin's contract with the design system — and not only on the markup ui chose
 * to emit for them, which is ui's business and changes without this package changing.
 */
export function nodesOf(value: unknown): InertNode[] {
  if (value === null || value === undefined || typeof value === 'boolean') return [];
  if (typeof value === 'string' || typeof value === 'number') return [];
  if (Array.isArray(value)) return value.flatMap(nodesOf);
  if (isInertNode(value)) {
    if (typeof value.type === 'function') return [value, ...nodesOf(value.type(value.props))];
    return [value, ...nodesOf(value.props['children'])];
  }
  if (typeof value === 'function') return nodesOf((value as () => unknown)());
  return [];
}

/**
 * The tree this package itself built: component nodes are kept but NOT called, so the walk stops
 * at the design-system boundary. Use this when a design-system component's own internals would
 * otherwise answer a query about the admin's markup — `<Dialog>` renders a close `<button>`, and a
 * test asking "which buttons did the action bar render" must not be handed ui's.
 */
export function shallowNodesOf(value: unknown): InertNode[] {
  if (value === null || value === undefined || typeof value === 'boolean') return [];
  if (typeof value === 'string' || typeof value === 'number') return [];
  if (Array.isArray(value)) return value.flatMap(shallowNodesOf);
  if (isInertNode(value)) return [value, ...shallowNodesOf(value.props['children'])];
  if (typeof value === 'function') return shallowNodesOf((value as () => unknown)());
  return [];
}

/** Nodes rendered by the named component — `byComponent(nodes, 'Money')`. */
export function byComponent(nodes: readonly InertNode[], name: string): InertNode[] {
  return nodes.filter((node) => typeof node.type === 'function' && node.type.name === name);
}

const SKIPPED_PROPS = new Set(['children', 'ref', 'innerHTML']);

function attributes(props: Record<string, unknown>): string {
  return Object.entries(props)
    .filter(([name, value]) => {
      if (SKIPPED_PROPS.has(name) || name.startsWith('on')) return false;
      return value !== undefined && value !== null && value !== false;
    })
    .map(([name, value]) => (value === true ? ` ${name}` : ` ${name}="${String(value)}"`))
    .join('');
}

/** The tree as markup. Unknown values are `String()`d, which the premise test refuses to allow. */
export function renderHtml(value: unknown): string {
  if (value === null || value === undefined || typeof value === 'boolean') return '';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(renderHtml).join('');
  if (isInertNode(value)) {
    if (typeof value.type === 'function') return renderHtml(value.type(value.props));
    const inner = renderHtml(value.props['children']);
    return `<${value.type}${attributes(value.props)}>${inner}</${value.type}>`;
  }
  if (typeof value === 'function') return renderHtml((value as () => unknown)());
  return String(value);
}

/** Render a component to its host nodes. `props` is the component's own, untyped on purpose. */
export function renderNodes(component: unknown, props: Record<string, unknown> = {}): InertNode[] {
  return nodesOf((component as InertComponent)(props));
}

/**
 * `renderNodes`, stopping at the design-system boundary — the `shallowNodesOf` sibling. The
 * `unknown` parameter is what makes it usable: a screen's props are typed and generic, so a test
 * calling one through `as (props: Record<string, unknown>) => unknown` is a conversion TypeScript
 * refuses outright. One widening here beats one per call site.
 */
export function renderShallowNodes(
  component: unknown,
  props: Record<string, unknown> = {},
): InertNode[] {
  return shallowNodesOf((component as InertComponent)(props));
}

/** Render a component to markup. */
export function renderComponent(component: unknown, props: Record<string, unknown> = {}): string {
  return renderHtml((component as InertComponent)(props));
}

export function byTag(nodes: readonly InertNode[], tag: string): InertNode[] {
  return nodes.filter((node) => node.type === tag);
}

/** Nodes whose attribute equals `value`; `undefined` matches "carries the attribute at all". */
export function withAttr(nodes: readonly InertNode[], name: string, value?: unknown): InertNode[] {
  return nodes.filter((node) =>
    value === undefined ? node.props[name] !== undefined : node.props[name] === value,
  );
}

/** The one node a test means, or a throw naming what it looked for — never a silent `undefined`. */
export function one(nodes: readonly InertNode[], what: string): InertNode {
  const node = nodes[0];
  if (node === undefined || nodes.length !== 1) {
    throw new Error(`expected exactly one ${what}, found ${nodes.length}`);
  }
  return node;
}

/** Call an element's event handler prop, e.g. `fire(button, 'onClick', {})`. */
export function fire(node: InertNode, handler: string, event: unknown): void {
  const fn = node.props[handler];
  if (typeof fn !== 'function') {
    throw new Error(`node <${String(node.type)}> carries no ${handler}`);
  }
  (fn as (e: unknown) => void)(event);
}
