// Any value as nested native `<details>`: keyboard and no-script for free, keys in the order given,
// long strings wrapped. A webhook body, an event, a tool call — whatever arrived prints as text.

import type { JSX } from 'solid-js';
import { cx } from '../cx';
import styles from './JsonView.module.scss';
import { type JsonViewNode, jsonViewTree } from './json-view-view';

export interface JsonViewProps {
  value: unknown;
  /** Already-translated name of the whole value. */
  label: string;
  /** Levels open on first paint; deeper containers start closed. Defaults to 1. */
  open?: number | undefined;
  class?: string | undefined;
}

function key(name: string | null): JSX.Element {
  return name === null ? null : <span class={styles['key']}>{name}</span>;
}

function leafText(tree: JsonViewNode): string {
  if (tree.kind === 'deep') return '…';
  if (tree.kind === 'circular') return '↺';
  if (tree.kind === 'string') return JSON.stringify(tree.value);
  return 'value' in tree ? tree.value : '';
}

function node(
  tree: JsonViewNode,
  depth: number,
  name: string | null,
  openDepth: number,
): JSX.Element {
  if (tree.kind === 'object' || tree.kind === 'array') {
    const [left, right] = tree.kind === 'array' ? ['[', ']'] : ['{', '}'];
    return (
      <details class={styles['branch']} open={depth < openDepth}>
        <summary class={styles['summary']}>
          {key(name)}
          <span class={styles['count']}>{`${left}${tree.size}${right}`}</span>
        </summary>
        <ul class={styles['entries']}>
          {tree.entries.map(([child, value]) => (
            <li>{node(value, depth + 1, child, openDepth)}</li>
          ))}
          {tree.more > 0 ? <li class={styles['more']}>{`… +${tree.more}`}</li> : null}
        </ul>
      </details>
    );
  }
  const text = leafText(tree);
  return (
    <span class={styles['leaf']}>
      {key(name)}
      <span class={styles[`value-${tree.kind}`]}>{text}</span>
    </span>
  );
}

export function JsonView(props: JsonViewProps): JSX.Element {
  return (
    // biome-ignore lint/a11y/useSemanticElements: a value read, not a form's fieldset
    <div class={cx(styles['json'], props.class)} role="group" aria-label={props.label} dir="ltr">
      {node(jsonViewTree(props.value), 0, null, props.open ?? 1)}
    </div>
  );
}
