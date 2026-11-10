// The `McpConfirmationStore` contract of `@ultimat3/mcp` as shared examples, structurally (an
// `McpConfirmationStore` is assignable): `behavesLike(mcpConfirmationStoreConformance, () => fresh())`.
// Every transition answers alike on every store. The subject must be EMPTY per check: `purge` counts.

import { expect, test } from 'bun:test';
import { uuidV7 } from '@ultimat3/core';
import type { SharedExamples } from './shared-examples';
import { sharedExamples } from './shared-examples';

type Maybe<T> = T | Promise<T>;

/** `@ultimat3/mcp`'s `McpConfirmation`, the fields the checks read. */
export interface McpConfirmationLike {
  readonly id: string;
  readonly orgId: string | null;
  readonly status: 'pending' | 'approved' | 'rejected';
  readonly expiresAt: Date;
  readonly decidedAt: Date | null;
  readonly decidedBy: string | null;
  readonly quorum: number;
  readonly approvers: readonly string[] | null;
  readonly approvals: readonly {
    readonly approver: string;
    readonly at: Date;
    readonly signature: string | null;
  }[];
  readonly consumedAt: Date | null;
}

/** `@ultimat3/mcp`'s `McpConfirmationDraft`, structurally. */
export interface McpConfirmationDraftLike {
  readonly id: string;
  readonly actorId: string;
  readonly orgId: string | null;
  readonly tool: string;
  readonly inputDigest: string;
  readonly sealedArguments: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly quorum?: number | undefined;
  readonly approvers?: readonly string[] | null | undefined;
}

/** The five members of `@ultimat3/mcp`'s `McpConfirmationStore`, structurally. */
export interface McpConfirmationStoreLike {
  open(
    draft: McpConfirmationDraftLike,
  ): Promise<{ readonly row: McpConfirmationLike; readonly created: boolean }>;
  get(id: string): Promise<McpConfirmationLike | undefined>;
  decide(
    id: string,
    status: 'approved' | 'rejected',
    by: string,
    at: Date,
    signature: string | null,
  ): Promise<McpConfirmationLike | undefined>;
  consume(id: string, at: Date): Promise<boolean>;
  purge(before: Date): Promise<number>;
}

export interface McpConfirmationStoreCheck {
  readonly name: string;
  run(store: McpConfirmationStoreLike): Promise<void>;
}

const T0 = Date.parse('2026-10-06T09:00:00.000Z');
const at = (seconds: number): Date => new Date(T0 + seconds * 1000);

const draft = (over: Partial<McpConfirmationDraftLike> = {}): McpConfirmationDraftLike => ({
  id: uuidV7(),
  actorId: 'agent-1',
  orgId: 'org-1',
  tool: 'refundOrder',
  inputDigest: 'a'.repeat(64),
  sealedArguments: 'x1.sealed-elsewhere',
  createdAt: at(0),
  expiresAt: at(600),
  ...over,
});

const OPEN: readonly McpConfirmationStoreCheck[] = [
  {
    name: 'open creates one pending row, and a second open for the same call returns it',
    async run(store) {
      const first = await store.open(draft());
      expect(first.created).toBe(true);
      expect(first.row).toMatchObject({
        status: 'pending',
        decidedAt: null,
        consumedAt: null,
        sealedArguments: 'x1.sealed-elsewhere',
      });
      expect(first.row.expiresAt.getTime()).toBe(at(600).getTime());
      const again = await store.open(draft());
      expect(again.created).toBe(false);
      expect(again.row.id).toBe(first.row.id);
    },
  },
  {
    name: 'two identical opens racing open one row',
    async run(store) {
      const both = await Promise.all([store.open(draft()), store.open(draft())]);
      expect(both.filter((each) => each.created)).toHaveLength(1);
      expect(new Set(both.map((each) => each.row.id)).size).toBe(1);
    },
  },
  {
    name: 'a different actor, org, tool or input is a different call',
    async run(store) {
      const base = await store.open(draft());
      for (const over of [
        { actorId: 'agent-2' },
        { orgId: 'org-2' },
        { orgId: null },
        { orgId: '' },
        { tool: 'other' },
        { inputDigest: 'b'.repeat(64) },
      ]) {
        const other = await store.open(draft(over));
        expect(other.created).toBe(true);
        expect(other.row.id).not.toBe(base.row.id);
      }
    },
  },
  {
    name: 'an approval in one org is not the open row of the same actor and call in another',
    async run(store) {
      const { row } = await store.open(draft({ orgId: 'o1' }));
      await store.decide(row.id, 'approved', 'user-9', at(10), null);
      const other = await store.open(draft({ orgId: 'o2' }));
      expect(other.created).toBe(true);
      expect(other.row).toMatchObject({ status: 'pending', orgId: 'o2' });
      const again = await store.open(draft({ orgId: 'o1' }));
      expect(again).toMatchObject({ created: false, row: { id: row.id, status: 'approved' } });
      // Consuming one org's row frees only that org's key.
      expect(await store.consume(row.id, at(20))).toBe(true);
      expect((await store.open(draft({ orgId: 'o2' }))).row.id).toBe(other.row.id);
    },
  },
];

const DECIDE: readonly McpConfirmationStoreCheck[] = [
  {
    name: 'decide moves pending to a decision once, and never a second time',
    async run(store) {
      const { row } = await store.open(draft());
      const approved = await store.decide(row.id, 'approved', 'user-9', at(10), null);
      expect(approved).toMatchObject({ status: 'approved', decidedBy: 'user-9' });
      expect(approved?.decidedAt?.getTime()).toBe(at(10).getTime());
      expect(await store.decide(row.id, 'rejected', 'user-9', at(11), null)).toBeUndefined();
      expect((await store.get(row.id))?.status).toBe('approved');
    },
  },
  {
    name: 'decide refuses a row past its expiry, and an unknown id',
    async run(store) {
      const { row } = await store.open(draft());
      expect(await store.decide(row.id, 'approved', 'user-9', at(600), null)).toBeUndefined();
      expect(await store.decide(uuidV7(), 'approved', 'user-9', at(1), null)).toBeUndefined();
      expect(await store.get(uuidV7())).toBeUndefined();
    },
  },
  {
    name: 'consume takes a row exactly once, and a consumed row frees the call for a new one',
    async run(store) {
      const { row } = await store.open(draft());
      expect(await store.consume(row.id, at(20))).toBe(true);
      expect(await store.consume(row.id, at(21))).toBe(false);
      expect((await store.get(row.id))?.consumedAt?.getTime()).toBe(at(20).getTime());
      const next = await store.open(draft());
      expect(next.created).toBe(true);
      expect(next.row.id).not.toBe(row.id);
      // A consumed row can no longer be decided: its call has already been answered.
      expect(await store.decide(row.id, 'approved', 'user-9', at(22), null)).toBeUndefined();
    },
  },
  {
    name: 'a quorum row counts one vote per approver and flips to approved at the quorum',
    async run(store) {
      const approvers = ['role:finance', 'actor:user-7'];
      const { row } = await store.open(draft({ quorum: 2, approvers }));
      expect(row).toMatchObject({ quorum: 2, approvers, approvals: [] });
      const first = await store.decide(row.id, 'approved', 'user-7', at(10), 'sig-7');
      expect(first).toMatchObject({ status: 'pending', decidedBy: null, decidedAt: null });
      expect(first?.approvals).toEqual([{ approver: 'user-7', at: at(10), signature: 'sig-7' }]);
      // The same approver again is no vote at all — the row is unchanged.
      expect(await store.decide(row.id, 'approved', 'user-7', at(11), 'sig-7')).toBeUndefined();
      expect((await store.get(row.id))?.approvals).toHaveLength(1);
      const second = await store.decide(row.id, 'approved', 'user-8', at(12), null);
      expect(second).toMatchObject({ status: 'approved', decidedBy: 'user-8' });
      expect(second?.decidedAt?.getTime()).toBe(at(12).getTime());
      expect(second?.approvals.map((vote) => [vote.approver, vote.signature])).toEqual([
        ['user-7', 'sig-7'],
        ['user-8', null],
      ]);
      expect(await store.decide(row.id, 'approved', 'user-9', at(13), null)).toBeUndefined();
    },
  },
  {
    name: 'one rejection settles a partly approved row, and a draft without a bar needs one',
    async run(store) {
      const { row } = await store.open(draft({ quorum: 3, approvers: ['role:finance'] }));
      await store.decide(row.id, 'approved', 'user-7', at(10), null);
      const rejected = await store.decide(row.id, 'rejected', 'user-8', at(11), null);
      expect(rejected).toMatchObject({ status: 'rejected', decidedBy: 'user-8' });
      expect(await store.decide(row.id, 'approved', 'user-9', at(12), null)).toBeUndefined();
      const plain = await store.open(draft({ tool: 'plain' }));
      expect(plain.row).toMatchObject({ quorum: 1, approvers: null, approvals: [] });
    },
  },
  {
    name: 'approvers racing lose no vote, and the quorum flips the row exactly once',
    async run(store) {
      const { row } = await store.open(draft({ quorum: 2, approvers: ['role:finance'] }));
      const votes = await Promise.all(
        ['user-1', 'user-2', 'user-3'].map((by) =>
          store.decide(row.id, 'approved', by, at(10), null),
        ),
      );
      // Two land (the second flips it), the third finds it approved; whichever order they ran in.
      expect(votes.filter((vote) => vote !== undefined)).toHaveLength(2);
      const held = await store.get(row.id);
      expect(held?.status).toBe('approved');
      expect(held?.approvals).toHaveLength(2);
    },
  },
  {
    name: 'a vote past the expiry is refused even with the quorum half met',
    async run(store) {
      const { row } = await store.open(draft({ quorum: 2, approvers: ['role:finance'] }));
      await store.decide(row.id, 'approved', 'user-7', at(10), null);
      expect(await store.decide(row.id, 'approved', 'user-8', at(600), null)).toBeUndefined();
      expect((await store.get(row.id))?.status).toBe('pending');
    },
  },
  {
    name: 'purge deletes what expired before the instant, and counts it',
    async run(store) {
      const gone = await store.open(draft({ expiresAt: at(60) }));
      const live = await store.open(draft({ tool: 'kept', expiresAt: at(6000) }));
      expect(await store.purge(at(120))).toBe(1);
      expect(await store.get(gone.row.id)).toBeUndefined();
      expect(await store.get(live.row.id)).toBeDefined();
      // The purged row's call is free again.
      expect((await store.open(draft({ expiresAt: at(60) }))).created).toBe(true);
    },
  },
];

export const MCP_CONFIRMATION_STORE_CHECKS: readonly McpConfirmationStoreCheck[] = [
  ...OPEN,
  ...DECIDE,
];

export const mcpConfirmationStoreConformance: SharedExamples<Maybe<McpConfirmationStoreLike>> =
  sharedExamples('an MCP confirmation store', (subject) => {
    for (const check of MCP_CONFIRMATION_STORE_CHECKS) {
      test(check.name, async () => {
        await check.run(await subject());
      });
    }
  });
