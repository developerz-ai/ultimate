// TEST-ONLY. A hand-built node tree and a test-only serialiser over it, so a test can construct a
// tree it did not render and read an admin view as markup. The walker is public: `nodesOf`,
// `byComponent` and the selectors are `@ultimat3/core/render-nodes`, and this file reads nodes
// through its `isRenderNode` — recognising neither shape is what asserts against "[object Object]".

import { isRenderNode, type RenderComponent, type RenderNode } from '@ultimat3/core/render-nodes';

/**
 * Build a node by hand, the shape the render factory builds — what a test uses to construct a tree
 * it did not render.
 */
export function h(
  type: string | RenderComponent,
  props: Record<string, unknown> | null,
  ...children: readonly unknown[]
): RenderNode {
  const base = { ...(props ?? {}) };
  if (children.length > 0) base['children'] = children.length === 1 ? children[0] : children;
  return { inert: true, type, props: base } as RenderNode;
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
  if (isRenderNode(value)) {
    if (typeof value.type === 'function') return renderHtml(value.type(value.props));
    const inner = renderHtml(value.props['children']);
    return `<${value.type}${attributes(value.props)}>${inner}</${value.type}>`;
  }
  if (typeof value === 'function') return renderHtml((value as () => unknown)());
  return String(value);
}

/** Render a component to markup. `component` is `unknown`: a screen's typed props never widen. */
export function renderComponent(component: unknown, props: Record<string, unknown> = {}): string {
  return renderHtml((component as RenderComponent)(props));
}
