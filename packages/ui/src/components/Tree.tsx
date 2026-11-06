// Files, folders, org charts: one node list, two renderings. With `hrefFor` it is nested `<ul>` and
// `<details>` with links — open and close are the platform's, 0 B of script. With `onSelect` it is
// an APG `role="tree"` with one tab stop, arrows, type-ahead and lazy children: an island's.

import type { JSX } from 'solid-js';
import { cx } from '../cx';
import { TREE_ITEM_SELECTOR } from '../roving';
import { useUi } from '../theme/context';
import { solid } from '../theme/solid-adapter';
import styles from './Tree.module.scss';
import { type TreeItemState, TreeLinkNode, TreeSelectNode } from './tree-node';
import {
  flattenTree,
  type TreeNode,
  treeAncestors,
  treeMove,
  treeTypeahead,
  visibleTreeIds,
  withLoadedChildren,
} from './tree-view';

interface TreeBaseProps {
  nodes: readonly TreeNode[];
  /** Already-translated accessible name. */
  label: string;
  /** The current node: `aria-current="page"` in link mode, `aria-selected` in select mode. Its ancestors open. */
  selected?: string | undefined;
  /** Branches open on first render, beside the selected node's ancestors. */
  open?: readonly string[] | undefined;
  class?: string | undefined;
}

/** Link mode: every leaf is a link. Works with scripting off. */
export interface TreeLinkProps extends TreeBaseProps {
  hrefFor: (node: TreeNode) => string;
  onSelect?: undefined;
  onExpand?: undefined;
}

/** Select mode, in an island: `role="tree"`, and `onExpand` fetches a `lazy` node's children. */
export interface TreeSelectProps extends TreeBaseProps {
  onSelect: (id: string) => void;
  onExpand?: ((id: string) => Promise<readonly TreeNode[]>) | undefined;
  hrefFor?: undefined;
}

export type TreeProps = TreeLinkProps | TreeSelectProps;

const MODIFIED = (event: KeyboardEvent): boolean => event.ctrlKey || event.metaKey || event.altKey;

export function Tree(props: TreeProps): JSX.Element {
  const rt = solid();
  const ui = useUi();
  const [loaded, setLoaded] = rt.createSignal<ReadonlyMap<string, readonly TreeNode[]>>(new Map());
  const [loading, setLoading] = rt.createSignal<ReadonlySet<string>>(new Set());
  const nodes = rt.createMemo(() => withLoadedChildren(props.nodes, loaded()));
  const flat = rt.createMemo(() => flattenTree(nodes()));
  const initialOpen = (): ReadonlySet<string> =>
    new Set([...(props.open ?? []), ...treeAncestors(flat(), props.selected)]);
  const [open, setOpen] = rt.createSignal<ReadonlySet<string>>(initialOpen());
  const [active, setActive] = rt.createSignal<string | undefined>(undefined);
  let root: HTMLUListElement | undefined;

  const states = rt.createMemo(
    () =>
      new Map<string, TreeItemState>(
        flat().map((entry) => [
          entry.node.id,
          {
            level: entry.level,
            setsize: entry.setsize,
            posinset: entry.posinset,
            branch: entry.branch,
          },
        ]),
      ),
  );

  /** One tab stop: the node last moved to, else the selected one if reachable, else the first. */
  const stop = (): string | undefined => {
    const visible = visibleTreeIds(flat(), open());
    const chosen = active() ?? props.selected;
    return chosen !== undefined && visible.includes(chosen) ? chosen : visible[0];
  };

  const focusNode = (id: string): void => {
    setActive(id);
    const items =
      root === undefined ? [] : [...root.querySelectorAll<HTMLElement>(TREE_ITEM_SELECTOR)];
    items.find((item) => item.dataset['treeId'] === id)?.focus();
  };

  const setNodeOpen = (id: string, next: boolean): void => {
    const copy = new Set(open());
    if (next) copy.add(id);
    else copy.delete(id);
    setOpen(copy);
    const node = flat().find((entry) => entry.node.id === id)?.node;
    const onExpand = props.onExpand;
    if (!next || onExpand === undefined || node?.lazy !== true || loaded().has(id)) return;
    setLoading(new Set([...loading(), id]));
    const settle = (): void => setLoading(new Set([...loading()].filter((each) => each !== id)));
    void onExpand(id).then(
      (children) => {
        setLoaded(new Map([...loaded(), [id, children]]));
        settle();
      },
      (error: unknown) => {
        // Closed again, and the rejection kept: a fetch that failed is the caller's to report.
        settle();
        setOpen(new Set([...open()].filter((each) => each !== id)));
        throw error;
      },
    );
  };

  const activate = (id: string): void => {
    setActive(id);
    props.onSelect?.(id);
    if (states().get(id)?.branch === true) setNodeOpen(id, !open().has(id));
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    const item = (event.target as Element | null)?.closest?.('[role="treeitem"]');
    const current = item instanceof HTMLElement ? item.dataset['treeId'] : undefined;
    if (current === undefined) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      activate(current);
      return;
    }
    const move = treeMove(flat(), open(), current, event.key, ui.dir);
    if (move !== undefined) {
      event.preventDefault();
      if (move.kind === 'focus') focusNode(move.id);
      else setNodeOpen(move.id, move.kind === 'open');
      return;
    }
    if (event.key.length === 1 && !MODIFIED(event)) {
      const found = treeTypeahead(flat(), open(), current, event.key, ui.locale);
      if (found !== undefined) focusNode(found);
    }
  };

  return (
    <div class={cx(styles['tree'], props.class)}>
      {props.hrefFor !== undefined ? (
        <ul class={styles['root']} aria-label={props.label}>
          {nodes().map((node) => (
            <TreeLinkNode
              node={node}
              hrefFor={props.hrefFor as (node: TreeNode) => string}
              selected={props.selected}
              open={initialOpen()}
            />
          ))}
        </ul>
      ) : (
        <ul
          class={styles['root']}
          // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: APG's tree is a list of items, one keydown on the root
          role="tree"
          aria-label={props.label}
          onKeyDown={onKeyDown}
          ref={(el: HTMLUListElement) => {
            root = el;
          }}
        >
          {nodes().map((node) => (
            <TreeSelectNode
              node={node}
              state={(id) => states().get(id)}
              isOpen={(id) => open().has(id)}
              isLoading={(id) => loading().has(id)}
              isStop={(id) => stop() === id}
              selected={props.selected}
              childrenOf={(each) => each.children ?? []}
              onActivate={activate}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
