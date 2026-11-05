// The one reader of the browser's accessibility nodes: what the BROWSER computed for a screen
// reader, after ARIA, label association and `aria-hidden` pruning. `x shot` reads one selector's
// node through it (`cli/src/cdp-shot-a11y.ts`), the e2e audit a whole document (`e2e-a11y.ts`).
// Every answer is somebody else's JSON, read and never cast.

/** What a screen reader is told about one element — the browser's computed role and name. */
export interface AxNode {
  readonly role: string;
  readonly name: string;
  readonly description?: string | undefined;
  readonly value?: string | undefined;
  readonly focused?: boolean | undefined;
  readonly disabled?: boolean | undefined;
  readonly ignored: boolean;
}

/**
 * One node of a full tree, with the two facts the audit keys on that `AxNode` drops: whether the
 * role is an ARIA `role` or Chrome's `internalRole` (so the document's `RootWebArea` is never
 * confused with an author's string), and the DOM node it describes. `html` and `matches` are
 * filled only for a node the caller asked to have described — one round trip each, never all.
 */
export interface AxTreeNode extends AxNode {
  readonly roleType: string;
  readonly backendNodeId?: number | undefined;
  /** The element's `outerHTML`, bounded by the describer. */
  readonly html?: string | undefined;
  /** Which of the selectors the describer was handed this element matches. */
  readonly matches?: readonly string[] | undefined;
}

export const axRecord = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;

/** CDP's `AXValue.value` is any scalar; a reader is told text. */
const textOf = (wrapped: unknown): string | undefined => {
  const value = axRecord(wrapped)?.['value'];
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? String(value)
    : undefined;
};

const flagOf = (node: Readonly<Record<string, unknown>>, name: string): boolean | undefined => {
  const properties = node['properties'];
  if (!Array.isArray(properties)) return undefined;
  const found = properties.map(axRecord).find((property) => property?.['name'] === name);
  return found === undefined ? undefined : axRecord(found['value'])?.['value'] === true;
};

const readNode = (node: Readonly<Record<string, unknown>>): AxNode => {
  const description = textOf(node['description']);
  const value = textOf(node['value']);
  const focused = flagOf(node, 'focused');
  const disabled = flagOf(node, 'disabled');
  return {
    role: textOf(node['role']) ?? '',
    name: textOf(node['name']) ?? '',
    ...(description === undefined ? {} : { description }),
    ...(value === undefined ? {} : { value }),
    ...(focused === undefined ? {} : { focused }),
    ...(disabled === undefined ? {} : { disabled }),
    ignored: node['ignored'] === true,
  };
};

/**
 * `nodes[0]` is the element's own node when `fetchRelatives` is false. An EMPTY list is a real
 * answer — an element that never entered the tree — and is kept as ignored, so the count the
 * caller gets is the count of matches.
 */
export const toAxNode = (answer: Readonly<Record<string, unknown>> | undefined): AxNode => {
  const nodes = answer?.['nodes'];
  const node = Array.isArray(nodes) ? axRecord(nodes[0]) : undefined;
  return node === undefined ? { role: '', name: '', ignored: true } : readNode(node);
};

/** Every node of a full-tree answer, in the browser's order. A non-object entry is skipped. */
export const toAxTreeNodes = (
  answer: Readonly<Record<string, unknown>> | undefined,
): readonly AxTreeNode[] => {
  const nodes = answer?.['nodes'];
  if (!Array.isArray(nodes)) return [];
  const out: AxTreeNode[] = [];
  for (const raw of nodes) {
    const node = axRecord(raw);
    if (node === undefined) continue;
    const roleType = axRecord(node['role'])?.['type'];
    const backendNodeId = node['backendDOMNodeId'];
    out.push({
      ...readNode(node),
      roleType: typeof roleType === 'string' ? roleType : '',
      ...(typeof backendNodeId === 'number' ? { backendNodeId } : {}),
    });
  }
  return out;
};
