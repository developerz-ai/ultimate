/**
 * The server JSX factory. `h` builds an inert node — no DOM, no reactivity, no `solid-js` — so a
 * page component stays a pure function from props to a tree, and `render-html.ts` is the only
 * thing that decides what a tree means. This is what the `.tsx` loader compiles every element to.
 */

/** Registered on the global symbol registry: two copies of this module must agree on a node. */
export const JSX_NODE: unique symbol = Symbol.for('ultimate.render.jsx') as never;

export type JsxProps = Readonly<Record<string, unknown>>;

/** A component is any function of props. Async is allowed: `render-html.ts` awaits it. */
export type JsxComponent = (props: JsxProps) => unknown;

export interface JsxNode {
  readonly [JSX_NODE]: true;
  /** A lowercase string is an element; a function is a component. */
  readonly type: string | JsxComponent;
  readonly props: JsxProps;
}

export function isJsxNode(value: unknown): value is JsxNode {
  return typeof value === 'object' && value !== null && JSX_NODE in value;
}

/**
 * Children live in `props.children`, the shape Solid and every JSX author already writes — so a
 * component reading `props.children` behaves the same whether its children came from the classic
 * factory's rest arguments or from an explicit `children` prop.
 */
export function h(type: string, props: JsxProps | null, ...children: readonly unknown[]): JsxNode;
/**
 * A component, with the props IT declares. `JsxComponent` takes any record, so a component typed
 * for its own props — an `island()`, a page's `Shell` — is not one under `strictFunctionTypes`,
 * and a hand-written `h(Toggle, { label })` was refused where the `.tsx` loader's own call is not.
 * The props are checked against the component here; `children` rides as the rest arguments.
 */
export function h<Props extends object>(
  type: (props: Props) => unknown,
  props: Omit<Props, 'children'> | null,
  ...children: readonly unknown[]
): JsxNode;
export function h(
  type: string | JsxComponent,
  props: JsxProps | null,
  ...children: readonly unknown[]
): JsxNode;
export function h(
  // `never` is the one parameter type every component's props satisfy.
  type: string | ((props: never) => unknown),
  props: object | null,
  ...children: readonly unknown[]
): JsxNode {
  // The overloads above are where a call is checked; a node carries the pair erased, which is all
  // `render-html.ts` ever reads — it hands `props` back to the `type` it arrived with.
  const erased = type as string | JsxComponent;
  const base = (props ?? {}) as JsxProps;
  if (children.length === 0) return { [JSX_NODE]: true, type: erased, props: base };
  return {
    [JSX_NODE]: true,
    type: erased,
    props: { ...base, children: children.length === 1 ? children[0] : children },
  };
}

/** `<>…</>`. A fragment is its children and nothing else — no wrapper element in the output. */
export const Fragment: JsxComponent = (props) => (props as { children?: unknown }).children;
