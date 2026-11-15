// Where a FRAME's document is, in the page's own protocol session — the root a frame's
// accessibility read is scoped to, found the way Chrome 157 answers it (measured 2026-11-15).
//
// `Page.getFrameTree` names the frame's id; `DOM.getFrameOwner` gives its `<iframe>`, whose
// `contentDocument` (read with `pierce`) is pushed to the session as a node id. A cross-site frame
// under site isolation is in neither: it renders in another process, and is refused by name.

import type { StandardSchemaV1 } from '@ultimat3/schema';
import { parse, t } from '@ultimat3/schema';
import type { AxRoot } from './cdp-a11y';
import { frameOutOfProcess } from './error-throws-session';

/** Which frame: what the library's frame handle can say about itself, and its place among twins. */
export interface FrameAddress {
  readonly name: string;
  readonly url: string;
  /** Its index among the page's frames with the SAME name and URL, in the library's order. */
  readonly ordinal: number;
}

interface FrameInfo {
  readonly id: string;
  readonly name?: string | undefined;
  readonly url: string;
}

// `.min(0)` for the reason `cdp-a11y.ts` gives: an unnamed frame's name is the empty string.
const anyString = t.string.min(0);
// One level at a time: the tree nests to any depth and the schema language has no recursion, so
// each child is parsed when the walk reaches it — never cast.
const treeNode = t.object({
  frame: t.object({ id: t.string, name: t.optional(anyString), url: anyString }),
  childFrames: t.optional(t.array(t.json())),
}) as unknown as StandardSchemaV1<
  unknown,
  { frame: FrameInfo; childFrames?: readonly unknown[] | undefined }
>;
const treeSchema = t.object({ frameTree: t.json() });
const ownerSchema = t.object({ backendNodeId: t.number });
const describedSchema = t.object({
  node: t.object({ contentDocument: t.optional(t.object({ backendNodeId: t.number })) }),
});
const pushedSchema = t.object({ nodeIds: t.array(t.number) });

/** Every frame below `raw`, depth first — the order the library lists them in. */
const below = (raw: unknown): FrameInfo[] =>
  (parse(treeNode, raw).childFrames ?? []).flatMap((child) => [
    parse(treeNode, child).frame,
    ...below(child),
  ]);

/** The root of `frame`'s document in the page session, or `X_SCRAPE_FRAME_OUT_OF_PROCESS`. */
export function frameDocument(driver: string, frame: FrameAddress): AxRoot {
  return async (session) => {
    const { frameTree } = parse(treeSchema, await session.send('Page.getFrameTree'));
    const twins = below(frameTree).filter(
      (candidate) => (candidate.name ?? '') === frame.name && candidate.url === frame.url,
    );
    const found = twins[frame.ordinal];
    if (found === undefined) throw frameOutOfProcess(driver, frame.name || frame.url);
    const owner = parse(
      ownerSchema,
      await session.send('DOM.getFrameOwner', { frameId: found.id }),
    );
    const { node } = parse(
      describedSchema,
      await session.send('DOM.describeNode', {
        backendNodeId: owner.backendNodeId,
        depth: 1,
        pierce: true,
      }),
    );
    if (node.contentDocument === undefined) {
      throw frameOutOfProcess(driver, frame.name || frame.url);
    }
    const [root] = parse(
      pushedSchema,
      await session.send('DOM.pushNodesByBackendIdsToFrontend', {
        backendNodeIds: [node.contentDocument.backendNodeId],
      }),
    ).nodeIds;
    if (root === undefined) throw frameOutOfProcess(driver, frame.name || frame.url);
    return root;
  };
}
