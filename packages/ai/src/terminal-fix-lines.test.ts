/**
 * A code a job dead-letters on the first attempt must not tell the reader to configure retries.
 * The failure first: `X_LLM_TOOL_ARGUMENTS_INVALID` was registered `terminal` while its fix still
 * read `retry: { attempts: 2 }` — advice the classification had just made a no-op.
 */

import { describe, expect, test } from 'bun:test';
import { AgentTranscriptInvalidError } from './agent-errors';
import {
  AiProviderUnexpectedError,
  LlmToolArgumentsError,
  LlmTruncatedError,
} from './answer-errors';
import { LlmOutputInvalidError } from './errors';
import { AI_ERROR_RETRY } from './errors-retry';

const billed = {
  usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
  cost: { minor: 1, currency: 'USD' },
  calls: 1,
  unsettled: 0,
};
const TERMINAL = [
  new LlmTruncatedError({ prompt: 'p@1', maxTokens: 100 }),
  new LlmOutputInvalidError({ prompt: 'p@1', attempts: 2, issues: 'x' }),
  new LlmToolArgumentsError({ provider: 'p', model: 'm', tool: 'respond', chars: 9, billed }),
  new AgentTranscriptInvalidError({ agent: 'a@1', reason: 'r' }),
  new AiProviderUnexpectedError({ provider: 'p', model: 'm', reason: 'weird', billed }),
];

describe('a terminal failure never advises a retry policy', () => {
  for (const error of TERMINAL) {
    test(error.code, () => {
      expect(error.fix).not.toMatch(/retry:|attempts:/);
      if (error.code in AI_ERROR_RETRY) expect(error.retry).toBe('terminal');
    });
  }

  test('unparseable tool arguments: the fix is the schema or the ceiling', () => {
    const fix = TERMINAL[2]?.fix ?? '';
    expect(fix).toContain('maxTokens');
    expect(fix).toContain('"respond"');
  });
});
