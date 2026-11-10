// The shared harness for the quorum and signed-evidence attack suites: a gated refund tool, an
// `mcpConfirmations({ approvers, evidence })` over a memory store an attack can tamper with, a clock
// a test moves, and Ed25519 device keys for each approver. Test-only, by its `-fixture` name.

import { expect } from 'bun:test';
import { registerAction } from '@ultimat3/action/loader';
import type { Actor } from '@ultimat3/core';
import {
  agentActor,
  generateMasterKey,
  isUltimateError,
  SECRETS_KEY_ENV,
  userActor,
} from '@ultimat3/core';
import type { JsonValue } from '@ultimat3/schema';
import { defineAppMcp } from './app-tools';
import type { McpConfirmationApprovers } from './confirmation-approvers';
import type { McpEvidenceCheck } from './confirmation-evidence';
import type { McpConfirmation, McpConfirmationStore } from './confirmation-store';
import { memoryConfirmationStore } from './confirmation-store';
import { mcpConfirmations } from './confirmations';
import type { AnyMcpTool } from './registry';
import { textResult } from './registry';

export const SEAL = {
  root: '/nonexistent/mcp-quorum',
  env: { [SECRETS_KEY_ENV]: generateMasterKey() },
};
export const T0 = Date.parse('2026-11-06T09:00:00.000Z');
export const TTL = 60_000;

export const finance = (id: string, extra: Partial<Parameters<typeof userActor>[0]> = {}): Actor =>
  userActor({ id, orgId: 'o1', roles: ['finance'], permissions: ['mcp:confirm'], ...extra });
export const ana = finance('u-ana');
export const ben = finance('u-ben');
export const agent = agentActor({ id: 'agent-1', orgId: 'o1' });

export const encode = (text: string) => new TextEncoder().encode(text);
export const keyPair = async (): Promise<CryptoKeyPair> =>
  (await crypto.subtle.generateKey('Ed25519', false, ['sign', 'verify'])) as CryptoKeyPair;
export const sign = async (key: CryptoKeyPair, payload: string): Promise<string> =>
  new Uint8Array(await crypto.subtle.sign('Ed25519', key.privateKey, encode(payload))).toBase64({
    alphabet: 'base64url',
    omitPadding: true,
  });

/** An app's key registry: approver id → the public keys registered to them. */
export const registryVerify =
  (keys: ReadonlyMap<string, CryptoKeyPair>) =>
  async ({ approver, payload, signature }: McpEvidenceCheck): Promise<boolean> => {
    const key = keys.get(approver);
    if (key === undefined) return false;
    const bytes = Uint8Array.fromBase64(signature, { alphabet: 'base64url' });
    return crypto.subtle.verify('Ed25519', key.publicKey, bytes, encode(payload));
  };

export const refundTool = (runs: { count: number }): AnyMcpTool => ({
  name: 'refundOrder',
  description: 'refunds an order',
  destructive: true,
  inputSchema: {
    type: 'object',
    properties: { orderId: { type: 'string' }, amount: { type: 'number' } },
    required: ['orderId', 'amount'],
    additionalProperties: false,
  },
  async handle(args) {
    runs.count += 1;
    return textResult(`refunded ${String(args['orderId'])}`);
  },
});

/** Over 1000 takes two finance approvers; anything else one. The issue's own declaration. */
export const byAmount = ({ args }: { readonly args: Readonly<Record<string, unknown>> }) =>
  ({
    quorum: Number(args['amount']) > 1000 ? 2 : 1,
    from: ['role:finance'],
  }) satisfies McpConfirmationApprovers;

export interface Options {
  readonly approvers?: (call: {
    readonly args: Readonly<Record<string, unknown>>;
  }) => McpConfirmationApprovers;
  readonly tamper?: (row: McpConfirmation) => McpConfirmation;
}

export async function harness(options: Options = {}) {
  const runs = { count: 0 };
  const inner = memoryConfirmationStore();
  // A server that writes the table around the decision action: rows the gate reads are altered.
  const store: McpConfirmationStore =
    options.tamper === undefined
      ? inner
      : {
          ...inner,
          open: async (draft) => {
            const opened = await inner.open(draft);
            return { ...opened, row: options.tamper?.(opened.row) ?? opened.row };
          },
        };
  let offset = 0;
  const clock = { now: () => new Date(T0 + offset), monotonic: () => offset };
  const keys = new Map([
    ['u-ana', await keyPair()],
    ['u-ben', await keyPair()],
    ['agent-1', await keyPair()],
  ]);
  let verifyThrows = false;
  const verify = registryVerify(keys);
  const confirm = mcpConfirmations({
    tools: ['refundOrder'],
    store,
    permission: 'mcp:confirm',
    approvers: options.approvers ?? byAmount,
    evidence: {
      verify: (check) => {
        if (verifyThrows) return Promise.reject(new Error('key store unreachable'));
        return verify(check);
      },
    },
    ttlMs: TTL,
    clock,
    sealKeys: SEAL,
  });
  registerAction('confirmRefunds', confirm);
  const app = defineAppMcp({
    tools: [refundTool(runs)],
    confirmations: confirm,
    errorAudience: 'developer',
  });
  let rpc = 0;
  const call = async (args: Record<string, JsonValue>, actor: Actor = agent) => {
    rpc += 1;
    const response = await app.server.handle(
      {
        jsonrpc: '2.0',
        id: rpc,
        method: 'tools/call',
        params: { name: 'refundOrder', arguments: args },
      },
      { actor, scopes: new Set() },
    );
    const result = response?.result as { content: { text: string }[] } | undefined;
    // No result is a JSON-RPC error — the transport's answer to a throw it cannot render.
    return result === undefined ? JSON.stringify(response) : (result.content[0]?.text ?? '');
  };
  /** A person's whole flow: view, sign what view returned with `signer`'s key, approve. */
  const approve = async (
    id: string,
    actor: Actor,
    over: {
      signer?: string;
      payload?: string;
      signature?: string | null;
      arguments?: Record<string, JsonValue>;
    } = {},
  ) => {
    const shown = await confirm.as(actor, { id, decision: 'view' });
    const key = keys.get(over.signer ?? actor.id);
    const signature =
      over.signature === null
        ? undefined
        : (over.signature ??
          (key === undefined ? 'x' : await sign(key, over.payload ?? shown.signingPayload)));
    return confirm.as(actor, {
      id,
      decision: 'approve',
      arguments: over.arguments ?? shown.arguments,
      ...(signature === undefined ? {} : { signature }),
    });
  };
  return {
    runs,
    store: inner,
    keys,
    verify,
    confirm,
    call,
    approve,
    advance: (ms: number) => {
      offset += ms;
    },
    failVerify: (on: boolean) => {
      verifyThrows = on;
    },
  };
}

export const idIn = (text: string): string =>
  /confirmation ([0-9a-f-]{36})/.exec(text)?.[1] ?? expect.unreachable(`no id in: ${text}`);

export const codeOf = async (promise: Promise<unknown>): Promise<string | undefined> => {
  try {
    await promise;
    return undefined;
  } catch (thrown) {
    return isUltimateError(thrown) ? thrown.code : 'not-an-ultimate-error';
  }
};

export const BIG = { orderId: 'o-1', amount: 5000 };
