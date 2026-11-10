// The `aiGateway` port's contract as shared examples: `behavesLike(gatewayConformance, () => ({
// gateway, model }))` — `model` registered and served, answered with a turn that costs something.
// The budget half is the point: `llm()`, `agent()` and `hive()` debit through `scope`, `spent` and
// `callLedger`, and a gateway that answers well and books nothing runs every app ceiling at zero.

import { expect, test } from 'bun:test';
import type { ModelId } from '@ultimat3/ai';
import type { Gateway } from '@ultimat3/ai/adapter';
import { isUltimateError } from '@ultimat3/core';
import { askOf, drained, expectStreamed, expectWellFormed } from './ai-conformance-answer';
import type { SharedExamples } from './shared-examples';
import { sharedExamples } from './shared-examples';

export interface GatewaySubject {
  readonly gateway: Gateway;
  /** Registered, served by the gateway, and answered at a cost above zero. */
  readonly model: ModelId;
}

export interface GatewayCheck {
  readonly name: string;
  run(subject: GatewaySubject): Promise<void>;
}

let minted = 0;
const actorKey = (): string => {
  minted += 1;
  return `actor:conformance:${process.pid.toString(36)}-${minted.toString(36)}`;
};

const codeOf = (pending: Promise<unknown>): Promise<string> =>
  pending.then(
    () => 'answered',
    (error: unknown) => (isUltimateError(error) ? error.code : `not coded: ${String(error)}`),
  );

export const GATEWAY_CHECKS: readonly GatewayCheck[] = [
  {
    name: 'generate answers a well-formed result for the model it was asked',
    async run({ gateway, model }) {
      expectWellFormed(await gateway.generate(askOf(model)), model);
    },
  },
  {
    name: 'stream ends on exactly one done chunk, whose text the deltas before it spell',
    async run({ gateway, model }) {
      expectStreamed(await drained(gateway.stream(askOf(model))), model);
    },
  },
  {
    name: 'outside a scope nothing is spent; inside one a call is spent, in its own currency',
    async run({ gateway, model }) {
      expect((await gateway.spent()).minor).toBe(0);
      const [result, spent] = await gateway.scope({ actorKey: actorKey() }, async () => {
        const answer = await gateway.generate(askOf(model));
        return [answer, await gateway.spent()] as const;
      });
      expect(result.cost.minor).toBeGreaterThan(0);
      expect(spent).toEqual({ minor: result.cost.minor, currency: result.cost.currency });
      expect((await gateway.spent()).minor).toBe(0);
    },
  },
  {
    name: 'calls inside one scope share its ledger, a streamed one included',
    async run({ gateway, model }) {
      const [one, two] = await gateway.scope({ actorKey: actorKey() }, async () => {
        await gateway.generate(askOf(model));
        const once = await gateway.spent();
        await drained(gateway.stream(askOf(model)));
        return [once, await gateway.spent()] as const;
      });
      expect(one.minor).toBeGreaterThan(0);
      expect(two.minor).toBeGreaterThan(one.minor);
    },
  },
  {
    name: "callLedger reports a ledger for the caller's keys, in Money",
    async run({ gateway }) {
      const report = await gateway.callLedger({ actorKey: actorKey() }).report();
      expect(Number.isSafeInteger(report.cost.minor)).toBe(true);
      expect(report.cost.currency).toMatch(/^[A-Z]{3}$/);
    },
  },
  {
    name: 'a maxTokens that is not a whole number is refused X_INVARIANT, on both calls',
    async run({ gateway, model }) {
      const bad = askOf(model, { maxTokens: Number.NaN });
      expect([
        await codeOf(gateway.generate(bad)),
        await codeOf(drained(gateway.stream(bad))),
      ]).toEqual(['X_INVARIANT', 'X_INVARIANT']);
    },
  },
];

export const gatewayConformance: SharedExamples<GatewaySubject> = sharedExamples(
  'an AI gateway',
  (subject) => {
    for (const check of GATEWAY_CHECKS) {
      test(check.name, async () => {
        await check.run(subject());
      });
    }
  },
);
