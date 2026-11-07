// A docs body, rendered: markdown through `@ultimat3/ui`'s `Markdown`, the one markdown path, every
// fence through its `CodeBlock` with every language — on the server, where a language costs 0 B.
// No `innerHTML` anywhere: raw HTML in a wiki page prints as text.

import { allLanguages, Markdown } from '@ultimat3/ui';
import type { JSX } from 'solid-js';
import styles from './doc-body.module.scss';

export function DocBody(props: { readonly markdown: string }): JSX.Element {
  // `baseLevel={1}`: a wiki `##` is an `h2` under the page's own `h1`. The reader took the page's
  // one `#` line out of the body (every wiki page has exactly one), so no second `h1` is left.
  return (
    <div class={styles.body}>
      <Markdown text={props.markdown} baseLevel={1} languages={allLanguages} />
    </div>
  );
}
