// The MCP confirmation-store suite over `@ultimat3/mcp`'s `memoryConfirmationStore()`, and the proof
// it can fail: a store whose `decide` takes a second vote from one approver, so one person meets a
// quorum of two alone.

import { describe, expect, test } from 'bun:test';
import type { McpConfirmationStore } from '@ultimat3/mcp';
import { memoryConfirmationStore } from '@ultimat3/mcp';
import {
  MCP_CONFIRMATION_STORE_CHECKS,
  mcpConfirmationStoreConformance,
} from './mcp-confirmation-store-conformance';
import { behavesLike } from './shared-examples';
import { testName } from './test-types';

describe(testName('unit', 'the memory MCP confirmation store'), () => {
  behavesLike(mcpConfirmationStoreConformance, () => memoryConfirmationStore());
});

/** Forgets who voted: each `decide` arrives as a stranger, so a repeat vote counts. */
const oneManQuorum = (): McpConfirmationStore => {
  const inner = memoryConfirmationStore();
  let votes = 0;
  return {
    ...inner,
    decide: (id, status, by, at, signature) => {
      votes += 1;
      return inner.decide(id, status, `${by}#${votes}`, at, signature);
    },
  };
};

describe(
  testName('unit', 'a confirmation store that breaks the contract fails conformance'),
  () => {
    test('a repeat vote from one approver counts toward the quorum', async () => {
      const quorum = MCP_CONFIRMATION_STORE_CHECKS.find((each) =>
        each.name.startsWith('a quorum row counts one vote per approver'),
      );
      if (quorum === undefined) return expect.unreachable('no conformance check for the quorum');
      await expect(quorum.run(oneManQuorum())).rejects.toThrow();
      await quorum.run(memoryConfirmationStore());
    });

    test('every check has a name of its own', () => {
      const names = MCP_CONFIRMATION_STORE_CHECKS.map((each) => each.name);
      expect(new Set(names).size).toBe(names.length);
    });
  },
);
