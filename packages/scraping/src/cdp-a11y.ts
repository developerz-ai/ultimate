// The accessibility tree, read over a raw CDP session — the one read in this package the browser
// library has no page method for, and the one no HTML parse can reproduce: `role` and `name` here
// are what the BROWSER computed for a screen reader, after ARIA, after the label association,
// after `aria-hidden` pruned the subtree. A `<div onclick>` answers no role and no name, which is
// the finding; a fake reading `role=` off the markup would answer the attribute and miss it.
//
// Four protocol calls per read, each parsed with a schema and never cast: the answers are
// somebody else's wire shapes, and a build that renames a field must refuse loudly
// (`X_VALIDATION_FAILED`, which `cdp-target.ts`'s `guard()` passes through unlabelled).

import type { StandardSchemaV1 } from '@ultimat3/schema';
import { parse, t } from '@ultimat3/schema';
import type { CdpSessionLike } from './cdp-port';
import type { AxNode } from './target';

const anyString = t.string.min(0);

/**
 * CDP's `AXValue`: `{ type, value, … }`, where `value` is typed `any` on the wire. A role and a
 * name are strings; a `value` may be a number (a slider) or a boolean (a checkbox), so every
 * scalar is accepted and rendered to text — `AxNode.value` is what a reader is TOLD, and a reader
 * is told text.
 */
const axValueSchema = t.object({
  value: t.optional(t.union(anyString, t.number, t.boolean)),
});

const axPropertySchema = t.object({
  name: t.string,
  value: axValueSchema,
});

const axNodeSchema = t.object({
  ignored: t.boolean,
  role: t.optional(axValueSchema),
  name: t.optional(axValueSchema),
  description: t.optional(axValueSchema),
  value: t.optional(axValueSchema),
  properties: t.optional(t.array(axPropertySchema)),
});

const documentSchema = t.object({ root: t.object({ nodeId: t.number }) });
const nodeIdsSchema = t.object({ nodeIds: t.array(t.number) });
const describedSchema = t.object({ node: t.object({ backendNodeId: t.number }) });
const partialTreeSchema = t.object({ nodes: t.array(axNodeSchema) });

type ParsedAxValue = { readonly value?: string | number | boolean | undefined };
type ParsedAxNode = {
  readonly ignored: boolean;
  readonly role?: ParsedAxValue | undefined;
  readonly name?: ParsedAxValue | undefined;
  readonly description?: ParsedAxValue | undefined;
  readonly value?: ParsedAxValue | undefined;
  readonly properties?: readonly { readonly name: string; readonly value: ParsedAxValue }[];
};

const textOf = (wrapped: ParsedAxValue | undefined): string | undefined =>
  wrapped?.value === undefined ? undefined : String(wrapped.value);

const flagOf = (node: ParsedAxNode, name: string): boolean | undefined => {
  const found = node.properties?.find((property) => property.name === name);
  return found === undefined ? undefined : found.value.value === true;
};

/**
 * `nodes[0]` is the node for the element itself when `fetchRelatives` is false — CDP answers a
 * list because the same command can walk ancestors. An EMPTY list is a real answer too: an element
 * that never entered the tree at all (a `<template>`, a detached subtree), which is recorded as
 * ignored with nothing computed, rather than dropped, so the count the caller gets is the count of
 * matches and not the count of nodes the browser deigned to describe.
 */
const toAxNode = (raw: unknown): AxNode => {
  const nodes = parse(
    partialTreeSchema as unknown as StandardSchemaV1<unknown, { nodes: ParsedAxNode[] }>,
    raw,
  ).nodes;
  const node = nodes[0];
  if (node === undefined) return { role: '', name: '', ignored: true };
  const description = textOf(node.description);
  const value = textOf(node.value);
  const focused = flagOf(node, 'focused');
  const disabled = flagOf(node, 'disabled');
  return {
    role: textOf(node.role) ?? '',
    name: textOf(node.name) ?? '',
    ...(description === undefined ? {} : { description }),
    ...(value === undefined ? {} : { value }),
    ...(focused === undefined ? {} : { focused }),
    ...(disabled === undefined ? {} : { disabled }),
    ignored: node.ignored,
  };
};

/**
 * The accessibility node of every element `selector` matches, in document order, at most `max`.
 *
 * The session is the CALLER's: `cdp-target.ts` creates it and detaches it in a `finally`, so a
 * throw from any of the four calls — a selector the browser refuses, a build whose answer does
 * not parse — never leaves a session attached behind the page. `max` is screened by the caller
 * too (`finiteCount`); here it is only a bound on the per-node round trips.
 */
export async function axNodesFor(
  session: CdpSessionLike,
  selector: string,
  max: number,
): Promise<readonly AxNode[]> {
  const document = parse(documentSchema, await session.send('DOM.getDocument', { depth: 0 }));
  const { nodeIds } = parse(
    nodeIdsSchema,
    await session.send('DOM.querySelectorAll', { nodeId: document.root.nodeId, selector }),
  );
  const out: AxNode[] = [];
  for (const nodeId of nodeIds.slice(0, max)) {
    const { node } = parse(describedSchema, await session.send('DOM.describeNode', { nodeId }));
    out.push(
      toAxNode(
        await session.send('Accessibility.getPartialAXTree', {
          backendNodeId: node.backendNodeId,
          fetchRelatives: false,
        }),
      ),
    );
  }
  return out;
}
