// `accessibility()` for the offline drivers: the HTML-AAM mapping of the markup — an explicit
// `role`, else the implicit one, and the accessible name in accname order.
//
// Name sources: `aria-labelledby`, `aria-label`, the native label, content, `title`, `placeholder`.
// No CSS and no script run here, so what a stylesheet hides or a script rewrites is not seen; the
// table below is the elements whose mapping needs neither, and every other element answers no
// role — the answer a `<div onclick>` must get, which is the defect this read finds.

import type { NameContext } from './html-a11y-context';
import { nameContexts } from './html-a11y-context';
import { queryHtml } from './html-query';
import type { AxNode, ElementSnapshot } from './target';

/** Input `type` → role. Absent and unknown types are text fields, as in a browser. */
const INPUT_ROLES: Readonly<Record<string, string>> = {
  button: 'button',
  submit: 'button',
  reset: 'button',
  image: 'button',
  checkbox: 'checkbox',
  radio: 'radio',
  range: 'slider',
  number: 'spinbutton',
  search: 'searchbox',
};

/** Tag → implicit role, for the elements whose mapping depends on nothing but the tag. */
const TAG_ROLES: Readonly<Record<string, string>> = {
  button: 'button',
  textarea: 'textbox',
  option: 'option',
  h1: 'heading',
  h2: 'heading',
  h3: 'heading',
  h4: 'heading',
  h5: 'heading',
  h6: 'heading',
  ul: 'list',
  ol: 'list',
  li: 'listitem',
  nav: 'navigation',
  main: 'main',
  article: 'article',
  aside: 'complementary',
  dialog: 'dialog',
  table: 'table',
  tr: 'row',
  td: 'cell',
  th: 'columnheader',
  p: 'paragraph',
  progress: 'progressbar',
};

/** Roles whose name comes from their content when nothing names them first (accname §4.3.2 F). */
const NAMED_FROM_CONTENT = new Set([
  'button',
  'link',
  'heading',
  'option',
  'cell',
  'columnheader',
  'checkbox',
  'radio',
  'tab',
  'menuitem',
  'treeitem',
  'row',
]);

/** Elements a `disabled` attribute applies to — elsewhere it is not a state a reader is told. */
const DISABLEABLE = new Set(['button', 'input', 'select', 'textarea', 'option', 'fieldset']);

const own = (record: Readonly<Record<string, string>>, key: string): string | undefined =>
  Object.hasOwn(record, key) ? record[key] : undefined;

const nonEmpty = (value: string | undefined): string | undefined => {
  const trimmed = value?.replaceAll(/\s+/g, ' ').trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
};

/** The element's role: the first token of an explicit `role`, else the implicit one, else none. */
export function roleOf(element: ElementSnapshot): string {
  const explicit = nonEmpty(own(element.attrs, 'role'))?.split(' ')[0]?.toLowerCase();
  if (explicit !== undefined) return explicit;
  const { tag, attrs } = element;
  if (tag === 'a' || tag === 'area') return own(attrs, 'href') === undefined ? '' : 'link';
  if (tag === 'img') return own(attrs, 'alt') === '' ? '' : 'image';
  if (tag === 'select') {
    const size = Number(own(attrs, 'size') ?? '0');
    return own(attrs, 'multiple') !== undefined || size > 1 ? 'listbox' : 'combobox';
  }
  if (tag === 'input') {
    const type = (own(attrs, 'type') ?? 'text').toLowerCase();
    if (type === 'hidden') return '';
    return own(INPUT_ROLES, type) ?? 'textbox';
  }
  return own(TAG_ROLES, tag) ?? '';
}

/**
 * `[id="…"]`, never `#…`: an id may hold characters a bare `#` selector reads as syntax. An id
 * carrying a quote or a backslash cannot be written safely, and resolves to nothing.
 */
const byId = (id: string): string | undefined => (/["\\]/.test(id) ? undefined : `[id="${id}"]`);

const textById = async (html: string, id: string): Promise<string | undefined> => {
  const selector = byId(id);
  return selector === undefined ? undefined : (await queryHtml(html, selector))[0]?.text;
};

/** `<label for=id>` text, for a labelable control that carries an id. */
const labelFor = async (html: string, element: ElementSnapshot): Promise<string | undefined> => {
  const id = own(element.attrs, 'id');
  if (id === undefined || /["\\]/.test(id)) return undefined;
  const labels = await queryHtml(html, `label[for="${id}"]`);
  return nonEmpty(labels.map((label) => label.text).join(' '));
};

const NO_CONTEXT: NameContext = { label: undefined, alts: [] };

const nativeName = async (
  html: string,
  element: ElementSnapshot,
  role: string,
  context: NameContext,
): Promise<string | undefined> => {
  const { tag, attrs } = element;
  const type = (own(attrs, 'type') ?? '').toLowerCase();
  if (tag === 'img' || tag === 'area' || (tag === 'input' && type === 'image')) {
    return nonEmpty(own(attrs, 'alt'));
  }
  if (tag === 'input' && (type === 'submit' || type === 'reset' || type === 'button')) {
    const fallback = type === 'submit' ? 'Submit' : type === 'reset' ? 'Reset' : undefined;
    return nonEmpty(own(attrs, 'value')) ?? fallback;
  }
  if (tag === 'input' || tag === 'textarea' || tag === 'select') {
    // `<label for>` first, then the label the control sits INSIDE — both are HTML's label
    // association (accname §4.3.2 D), and the wrapping form is the commoner one.
    const label = (await labelFor(html, element)) ?? nonEmpty(context.label);
    if (label !== undefined) return label;
  }
  // Content includes a descendant image's `alt`: `<a href="/"><img alt="Home"></a>` is "Home".
  return NAMED_FROM_CONTENT.has(role)
    ? nonEmpty([element.text, ...context.alts].join(' '))
    : undefined;
};

/** The accessible name, in the order accname walks the sources. `''` when nothing names it. */
export async function nameOf(
  html: string,
  element: ElementSnapshot,
  role: string,
  context: NameContext = NO_CONTEXT,
): Promise<string> {
  const { attrs } = element;
  const labelledBy = nonEmpty(own(attrs, 'aria-labelledby'));
  if (labelledBy !== undefined) {
    const parts: string[] = [];
    for (const id of labelledBy.split(' ')) {
      const text = nonEmpty(await textById(html, id));
      if (text !== undefined) parts.push(text);
    }
    if (parts.length > 0) return parts.join(' ');
  }
  const label = nonEmpty(own(attrs, 'aria-label'));
  if (label !== undefined) return label;
  const native = await nativeName(html, element, role, context);
  if (native !== undefined) return native;
  const title = nonEmpty(own(attrs, 'title'));
  if (title !== undefined) return title;
  return role === 'textbox' || role === 'searchbox'
    ? (nonEmpty(own(attrs, 'placeholder')) ?? '')
    : '';
}

/**
 * Every match's node, in document order, at most `max`. A node the markup hides (`hidden`,
 * `aria-hidden`, an inline `display: none`) is IGNORED with nothing computed, which is the answer a
 * browser's pruned subtree gives — `markupVisible`, the one definition of visible offline.
 */
export async function htmlAccessibility(
  html: string,
  selector: string,
  max: number,
): Promise<readonly AxNode[]> {
  const out: AxNode[] = [];
  // Same pass order as `queryHtml`, so entry `index` describes the same match.
  const contexts = await nameContexts(html, selector);
  for (const [index, element] of (await queryHtml(html, selector)).slice(0, max).entries()) {
    if (!element.visible) {
      out.push({ role: '', name: '', ignored: true });
      continue;
    }
    const role = roleOf(element);
    const name = await nameOf(html, element, role, contexts[index] ?? NO_CONTEXT);
    const disabled =
      !element.enabled &&
      (DISABLEABLE.has(element.tag) || own(element.attrs, 'aria-disabled') !== undefined);
    out.push({ role, name, ...(disabled ? { disabled: true } : {}), ignored: false });
  }
  return out;
}
