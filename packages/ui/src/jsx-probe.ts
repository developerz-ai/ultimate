// TEST-ONLY. Calls a component and walks what it returned, so a test can assert on the props an
// element actually carries — the `tabindex`, the `aria-live`, the `onKeyDown`, the `ref` — rather
// than on a string it was serialised into. Complements `theme/inert-render.test.ts`, which asks
// the other question (does the markup come out at all).
//
// Which JSX factory a `.tsx` in this package compiled to is NOT ours to choose: `@ultimat3/render`
// installs a process-global `Bun.plugin` `onLoad` for `/\.tsx$/` at import, and `bun test` is one
// process. Both factories build the same shape — a `type`, a `props`, children under
// `props.children` — so this walker recognises both and the run's file order stops deciding.

const RENDER_NODE: symbol = Symbol.for('ultimate.render.jsx');

export interface ProbeNode {
  readonly type: string | ((props: Record<string, unknown>) => unknown);
  readonly props: Record<string, unknown>;
}

export function isProbeNode(value: unknown): value is ProbeNode {
  if (typeof value !== 'object' || value === null) return false;
  return 'inert' in value || RENDER_NODE in value;
}

function h(
  type: ProbeNode['type'],
  props: Record<string, unknown> | null,
  ...children: readonly unknown[]
): ProbeNode {
  const base = { ...(props ?? {}) };
  if (children.length > 0) base['children'] = children.length === 1 ? children[0] : children;
  return { inert: true, type, props: base } as unknown as ProbeNode;
}

/**
 * How many probes are live, and what `globalThis.React` was before the first one. A harness that
 * DELETED the property on the way out destroyed a binding it did not create, and a nested or
 * repeated probe tore the factory out from under the suite still using it — the counter is what
 * makes the last unprobe the only one that restores.
 *
 * There may be exactly ONE such counter in the framework, and it is this one — `globalThis.React`
 * is a single property, so a second module counting its own depth over it restores in the wrong
 * order. `@ultimat3/admin`'s `inert-jsx.ts` kept a second pair and the two interleaved: admin
 * installs (saving the real binding), ui installs (saving ADMIN's factory), admin restores (both
 * counters at 1 → the real binding is back), ui restores (its counter hits 0 → admin's factory is
 * reinstalled over it). The global ended up holding a harness the run had already torn down.
 * `admin` is tier 5 and `ui` is tier 4, so admin imports these rather than declaring them.
 */
let depth = 0;
let saved: PropertyDescriptor | undefined;

/** Install the classic-factory global these `.tsx` files fall back to. Paired with `unprobe()`. */
export function probe(): void {
  if (depth === 0) {
    // The descriptor, not the value: the property may be a getter or non-writable, and `assign`
    // onto either throws or silently loses. `defineProperty` installs over both.
    saved = Object.getOwnPropertyDescriptor(globalThis, 'React');
    Object.defineProperty(globalThis, 'React', {
      value: { createElement: h },
      configurable: true,
      writable: true,
      enumerable: true,
    });
  }
  depth += 1;
}

/** Undo the matching `probe()`. Unbalanced calls are inert: nothing this did not install is torn
 * down, because the binding at depth 0 belongs to somebody else. */
export function unprobe(): void {
  if (depth === 0) return;
  depth -= 1;
  if (depth > 0) return;
  if (saved === undefined) Reflect.deleteProperty(globalThis, 'React');
  else Object.defineProperty(globalThis, 'React', saved);
  saved = undefined;
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
