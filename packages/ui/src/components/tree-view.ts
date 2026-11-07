// A tree's rules over plain data: flatten with level and position, the order arrows walk (a closed
// subtree is skipped), what a key does — left and right follow `dir` — and type-ahead. Pure, so
// `Tree` is markup over these and every keyboard rule is tested without a renderer.

import { renderCauseValue } from '@ultimat3/core';
import { UI_ERROR_CODES, UiError } from '../errors';

export interface TreeNode {
  id: string;
  /** Already-translated. */
  label: string;
  children?: readonly TreeNode[] | undefined;
  /** Children exist but are not loaded: an island's `onExpand(id)` fetches them. */
  lazy?: boolean | undefined;
  disabled?: boolean | undefined;
}

export interface FlatTreeNode {
  readonly node: TreeNode;
  readonly parent: string | undefined;
  /** 1-based, as `aria-level` wants it. */
  readonly level: number;
  readonly setsize: number;
  readonly posinset: number;
  /** Has children, loaded or not: it can be opened. */
  readonly branch: boolean;
}

function invalidTree(cause: string): UiError {
  return new UiError({
    code: UI_ERROR_CODES.invalidValue,
    cause: `<Tree> ${cause}`,
    fix: 'nodes: rows.map((row) => ({ id: row.id, label: row.name, children: [...] }))   # on <Tree>: one id per node, and no node inside its own subtree',
  });
}

/** Depth first, in document order. A repeated id, or a node inside its own subtree, throws. */
export function flattenTree(nodes: readonly TreeNode[]): readonly FlatTreeNode[] {
  const flat: FlatTreeNode[] = [];
  const seen = new Set<string>();
  const walk = (
    level: readonly TreeNode[],
    parent: string | undefined,
    depth: number,
    ancestors: ReadonlySet<string>,
  ): void => {
    level.forEach((node, index) => {
      if (ancestors.has(node.id)) {
        throw invalidTree(`node ${renderCauseValue(node.id)} is its own ancestor`);
      }
      if (seen.has(node.id)) throw invalidTree(`id ${renderCauseValue(node.id)} repeats`);
      seen.add(node.id);
      const children = node.children ?? [];
      flat.push({
        node,
        parent,
        level: depth,
        setsize: level.length,
        posinset: index + 1,
        branch: children.length > 0 || node.lazy === true,
      });
      walk(children, node.id, depth + 1, new Set([...ancestors, node.id]));
    });
  };
  walk(nodes, undefined, 1, new Set());
  return flat;
}

/** The ids a reader can reach: every node whose ancestors are all open. Disabled ones are skipped. */
export function visibleTreeIds(
  flat: readonly FlatTreeNode[],
  open: ReadonlySet<string>,
): readonly string[] {
  const shown = new Set<string>();
  const ids: string[] = [];
  for (const entry of flat) {
    if (entry.parent !== undefined && !(open.has(entry.parent) && shown.has(entry.parent)))
      continue;
    shown.add(entry.node.id);
    if (entry.node.disabled !== true) ids.push(entry.node.id);
  }
  return ids;
}

export type TreeMove =
  | { readonly kind: 'focus'; readonly id: string }
  | { readonly kind: 'open'; readonly id: string }
  | { readonly kind: 'close'; readonly id: string };

/**
 * What a key does from `current`, per the APG tree pattern. Right opens a closed branch and enters
 * an open one; Left closes an open branch and climbs from anything else. Under `dir="rtl"` the
 * two swap, because "inward" points the other way. `undefined` is a key the tree does not take.
 */
export function treeMove(
  flat: readonly FlatTreeNode[],
  open: ReadonlySet<string>,
  current: string,
  key: string,
  dir: 'ltr' | 'rtl',
): TreeMove | undefined {
  const visible = visibleTreeIds(flat, open);
  const index = visible.indexOf(current);
  const entry = flat.find((candidate) => candidate.node.id === current);
  if (entry === undefined) return undefined;
  const focus = (id: string | undefined): TreeMove | undefined =>
    id === undefined || id === current ? undefined : { kind: 'focus', id };
  const inward = dir === 'rtl' ? 'ArrowLeft' : 'ArrowRight';
  const outward = dir === 'rtl' ? 'ArrowRight' : 'ArrowLeft';
  switch (key) {
    case 'ArrowDown':
      return focus(visible[index + 1]);
    case 'ArrowUp':
      return index <= 0 ? undefined : focus(visible[index - 1]);
    case 'Home':
      return focus(visible[0]);
    case 'End':
      return focus(visible[visible.length - 1]);
    case inward:
      if (!entry.branch) return undefined;
      if (!open.has(current)) return { kind: 'open', id: current };
      return focus(
        flat.find((child) => child.parent === current && child.node.disabled !== true)?.node.id,
      );
    case outward:
      if (entry.branch && open.has(current)) return { kind: 'close', id: current };
      return focus(entry.parent);
    default:
      return undefined;
  }
}

/**
 * Type-ahead: the next visible node after `current` whose label starts with `typed`, wrapping.
 * Compared in `locale`, never the runtime's default, so a Turkish `i` matches its own capital.
 */
export function treeTypeahead(
  flat: readonly FlatTreeNode[],
  open: ReadonlySet<string>,
  current: string,
  typed: string,
  locale: string,
): string | undefined {
  const needle = typed.toLocaleLowerCase(locale);
  if (needle === '') return undefined;
  const visible = visibleTreeIds(flat, open);
  const labels = new Map(flat.map((entry) => [entry.node.id, entry.node.label]));
  const start = visible.indexOf(current);
  for (let step = 1; step <= visible.length; step += 1) {
    const id = visible[(start + step) % visible.length];
    if (id !== undefined && (labels.get(id) ?? '').toLocaleLowerCase(locale).startsWith(needle)) {
      return id;
    }
  }
  return undefined;
}

/** The ids to open so `id` is on screen: every ancestor of it. */
export function treeAncestors(
  flat: readonly FlatTreeNode[],
  id: string | undefined,
): readonly string[] {
  const parents = new Map(flat.map((entry) => [entry.node.id, entry.parent]));
  const ancestors: string[] = [];
  let at = id === undefined ? undefined : parents.get(id);
  while (at !== undefined) {
    ancestors.push(at);
    at = parents.get(at);
  }
  return ancestors;
}

/** The tree with each lazily fetched node's children in place. Unchanged nodes stay the same objects. */
export function withLoadedChildren(
  nodes: readonly TreeNode[],
  loaded: ReadonlyMap<string, readonly TreeNode[]>,
): readonly TreeNode[] {
  if (loaded.size === 0) return nodes;
  return nodes.map((node) => {
    const fetched = loaded.get(node.id);
    const children = fetched ?? node.children;
    if (children === undefined) return node;
    return { ...node, children: withLoadedChildren(children, loaded) };
  });
}
