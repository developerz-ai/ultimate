// One node of a `Tree`, in either of its two renderings. Link mode is the platform's: a branch is a
// `<details>` whose `<summary>` opens it, a leaf is a link — no script at all. Select mode is the
// APG tree item, which only an island drives; its state arrives as accessors from `Tree`.

import type { JSX } from 'solid-js';
import { ariaBool } from '../a11y';
import { UI_KEYS } from '../i18n-keys';
import { useUi } from '../theme/context';
import styles from './Tree.module.scss';
import type { TreeNode } from './tree-view';

export interface TreeLinkNodeProps {
  node: TreeNode;
  hrefFor: (node: TreeNode) => string;
  selected: string | undefined;
  open: ReadonlySet<string>;
}

/** Link mode: a `<details>` per branch, a link per leaf, `aria-current` on the selected one alone. */
export function TreeLinkNode(props: TreeLinkNodeProps): JSX.Element {
  const children = props.node.children ?? [];
  if (children.length === 0) {
    return (
      <li class={styles['item']}>
        <a
          class={styles['link']}
          href={props.hrefFor(props.node)}
          aria-current={props.selected === props.node.id ? 'page' : undefined}
        >
          {props.node.label}
        </a>
      </li>
    );
  }
  return (
    <li class={styles['item']}>
      <details class={styles['branch']} open={props.open.has(props.node.id)}>
        <summary class={styles['summary']}>{props.node.label}</summary>
        <ul class={styles['group']}>
          {children.map((child) => (
            <TreeLinkNode
              node={child}
              hrefFor={props.hrefFor}
              selected={props.selected}
              open={props.open}
            />
          ))}
        </ul>
      </details>
    </li>
  );
}

export interface TreeItemState {
  readonly level: number;
  readonly setsize: number;
  readonly posinset: number;
  readonly branch: boolean;
}

export interface TreeSelectNodeProps {
  node: TreeNode;
  /** Level and position, read from the flattened tree. */
  state: (id: string) => TreeItemState | undefined;
  isOpen: (id: string) => boolean;
  isLoading: (id: string) => boolean;
  /** The node holding the group's one tab stop. */
  isStop: (id: string) => boolean;
  selected: string | undefined;
  /** Loaded children: the node's own, or what `onExpand` answered for it. */
  childrenOf: (node: TreeNode) => readonly TreeNode[];
  onActivate: (id: string) => void;
}

/** Select mode: `role="treeitem"`, roving tab stop, `aria-expanded` only on a branch. */
export function TreeSelectNode(props: TreeSelectNodeProps): JSX.Element {
  const ui = useUi();
  const id = props.node.id;
  const branch = (): boolean => props.state(id)?.branch === true;
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the tree's one keydown handler sits on `Tree`'s root
    <li
      class={styles['item']}
      role="treeitem"
      data-tree-id={id}
      aria-level={props.state(id)?.level}
      aria-setsize={props.state(id)?.setsize}
      aria-posinset={props.state(id)?.posinset}
      aria-expanded={branch() ? ariaBool(props.isOpen(id)) : undefined}
      aria-selected={ariaBool(props.selected === id)}
      aria-disabled={props.node.disabled === true ? 'true' : undefined}
      aria-busy={ariaBool(props.isLoading(id) ? true : undefined)}
      tabIndex={props.isStop(id) ? 0 : -1}
      onClick={(event: MouseEvent) => {
        // The click lands on the innermost item only: a parent hearing its child's click would
        // toggle itself shut under the reader's pointer.
        event.stopPropagation();
        if (props.node.disabled !== true) props.onActivate(id);
      }}
    >
      <span class={styles['row']}>
        <span
          class={styles['twisty']}
          aria-hidden="true"
          data-open={props.isOpen(id) ? '' : undefined}
        >
          {branch() ? '▸' : ''}
        </span>
        <span class={styles['label']}>{props.node.label}</span>
        {props.isLoading(id) ? (
          <span class={styles['loading']}>{ui.t(UI_KEYS.treeLoading)}</span>
        ) : null}
      </span>
      {branch() && props.isOpen(id) ? (
        // biome-ignore lint/a11y/useSemanticElements: APG nests a tree item's children in a `group`
        <ul class={styles['group']} role="group">
          {props.childrenOf(props.node).map((child) => (
            <TreeSelectNode
              node={child}
              state={props.state}
              isOpen={props.isOpen}
              isLoading={props.isLoading}
              isStop={props.isStop}
              selected={props.selected}
              childrenOf={props.childrenOf}
              onActivate={props.onActivate}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}
