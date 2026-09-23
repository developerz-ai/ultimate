// The accessibility tree, read over the page's own CDP session: what the BROWSER computed for a
// screen reader, after ARIA, label association and `aria-hidden` pruning. A `<div onclick>`
// answers no role and no name, which is the finding — no read of the markup can reproduce it.
import type { AxNode } from './browser-launcher-port';

/** One session-scoped CDP call. Every answer is somebody else's JSON, read and never cast. */
export type SessionSend = (
  method: string,
  params?: Record<string, unknown>,
) => Promise<Readonly<Record<string, unknown>> | undefined>;

const record = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;

/** CDP's `AXValue.value` is any scalar; a reader is told text. */
const textOf = (wrapped: unknown): string | undefined => {
  const value = record(wrapped)?.['value'];
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? String(value)
    : undefined;
};

const flagOf = (node: Readonly<Record<string, unknown>>, name: string): boolean | undefined => {
  const properties = node['properties'];
  if (!Array.isArray(properties)) return undefined;
  const found = properties.map(record).find((property) => property?.['name'] === name);
  return found === undefined ? undefined : record(found['value'])?.['value'] === true;
};

/**
 * `nodes[0]` is the element's own node when `fetchRelatives` is false. An EMPTY list is a real
 * answer — an element that never entered the tree — and is kept as ignored, so the count the
 * caller gets is the count of matches.
 */
export const toAxNode = (answer: Readonly<Record<string, unknown>> | undefined): AxNode => {
  const nodes = answer?.['nodes'];
  const node = Array.isArray(nodes) ? record(nodes[0]) : undefined;
  if (node === undefined) return { role: '', name: '', ignored: true };
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

/** Every match of `selector`, in document order, at most `max` — one round trip per match. */
export async function axNodesFor(
  send: SessionSend,
  selector: string,
  max: number,
): Promise<readonly AxNode[]> {
  const root = record(record((await send('DOM.getDocument', { depth: 0 }))?.['root']));
  const nodeIds = (await send('DOM.querySelectorAll', { nodeId: root?.['nodeId'], selector }))?.[
    'nodeIds'
  ];
  const out: AxNode[] = [];
  for (const nodeId of Array.isArray(nodeIds) ? nodeIds.slice(0, max) : []) {
    const described = record((await send('DOM.describeNode', { nodeId }))?.['node']);
    out.push(
      toAxNode(
        await send('Accessibility.getPartialAXTree', {
          backendNodeId: described?.['backendNodeId'],
          fetchRelatives: false,
        }),
      ),
    );
  }
  return out;
}
