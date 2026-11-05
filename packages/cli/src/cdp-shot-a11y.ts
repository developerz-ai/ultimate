// The accessibility tree, read over the page's own CDP session: what the BROWSER computed for a
// screen reader, after ARIA, label association and `aria-hidden` pruning. A `<div onclick>`
// answers no role and no name, which is the finding — no read of the markup can reproduce it.
// The node READER is `@ultimat3/testing`'s, the one the e2e audit reads a whole tree with.
import { toAxNode } from '@ultimat3/testing';
import type { AxNode } from './browser-launcher-port';

/** One session-scoped CDP call. Every answer is somebody else's JSON, read and never cast. */
export type SessionSend = (
  method: string,
  params?: Record<string, unknown>,
) => Promise<Readonly<Record<string, unknown>> | undefined>;

const record = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;

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
