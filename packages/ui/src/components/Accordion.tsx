// Expandable sections built on `<details>`/`<summary>`: open/close, keyboard, focus and
// `aria-expanded` are the browser's, so the component works with JavaScript disabled and
// there is no open-state to hydrate. `exclusive` is the native `name` group, not a listener.

import type { JSX } from 'solid-js';
import { useId } from '../a11y';
import { cx } from '../cx';
import { iconChevronDown } from '../icons/glyphs/chevron-down';
import styles from './Accordion.module.scss';
import type { AccordionSection } from './accordion-view';
import { accordionOpenIds } from './accordion-view';
import type { HeadingLevel } from './heading-level';
import { headingTag } from './heading-level';
import { Icon } from './Icon';

export interface AccordionItem extends AccordionSection {
  /** Already-translated section title. */
  title: string;
  panel: JSX.Element;
  /** Expanded on first paint — a real `open` attribute, so no script has to run. */
  defaultOpen?: boolean | undefined;
}

export interface AccordionProps {
  items: readonly AccordionItem[];
  /** One section open at a time, through the native `<details name>` group. */
  exclusive?: boolean | undefined;
  /**
   * Wraps each title in a heading of this level, putting the sections in the page outline. Left
   * out, a title is plain text inside the disclosure button — which is what a screen reader
   * announces either way.
   */
  level?: HeadingLevel | undefined;
  /** Fires on every open and close, once the browser has already applied it. */
  onToggle?: ((id: string, open: boolean) => void) | undefined;
  class?: string | undefined;
}

export function Accordion(props: AccordionProps): JSX.Element {
  const base = useId('accordion');
  const open = accordionOpenIds(props.items, props.exclusive === true);
  const Title = props.level === undefined ? 'span' : headingTag(props.level);

  return (
    <div class={cx(styles['accordion'], props.class)}>
      {props.items.map((item) => (
        <details
          id={`${base}-${item.id}`}
          class={styles['section']}
          name={props.exclusive === true ? base : undefined}
          open={open.has(item.id)}
          onToggle={(event) => props.onToggle?.(item.id, event.currentTarget.open)}
        >
          <summary class={styles['summary']}>
            <Icon glyph={iconChevronDown} class={styles['marker']} size="sm" />
            <Title class={styles['title']}>{item.title}</Title>
          </summary>
          <div class={styles['panel']}>{item.panel}</div>
        </details>
      ))}
    </div>
  );
}
