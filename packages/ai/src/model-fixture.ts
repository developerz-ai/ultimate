// The rows this package's OWN suites register, as an app's `models.ts` would: the framework ships
// none (M12, 25.0.0), so a test that builds a request, prices a call or walks a ladder registers
// what it names first. Test data, not a price list — no reader outside `src/*.test.ts` sees it.
//
// Not shipped — `package.json` excludes `!src/**/*-fixture.ts`.

import { beforeEach } from 'bun:test';
import type { Money } from '@ultimat3/money';
import { registerModel } from './models';

const usd = (minor: number): Money => ({ minor, currency: 'USD' });

/**
 * Two families, most capable first, in Anthropic-format id shapes: the wire suites assert exact
 * bodies, and the ids are what those bodies carry. Each row exercises one reasoning shape — always
 * on, capped, `between_tools`, uncapped, none — so every branch of `reasoningBody` has a subject.
 */
export const FIXTURE_ANTHROPIC_IDS = [
  'claude-fable-5-1',
  'claude-opus-5-5',
  'claude-opus-5',
  'claude-sonnet-5-5',
  'claude-sonnet-5',
  'claude-haiku-4-5',
] as const;

/** The OpenAI-format family, the other ladder: `moreCapableThan` must never cross into it. */
export const FIXTURE_OPENAI_IDS = ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'] as const;

/** The model a suite's gateway falls back to: `providerGateway({ defaultModel: FIXTURE_MODEL })`. */
export const FIXTURE_MODEL = 'claude-opus-5';

const ANTHROPIC = { family: 'anthropic', input: ['image', 'document'] } as const;

const OPENAI = {
  family: 'openai',
  contextWindow: 1_050_000,
  maxOutput: 128_000,
  cacheMinimumTokens: 1_024,
  reasoning: { effort: true, adaptive: false, disableThinkingUpTo: undefined },
  input: ['image', 'document'],
} as const;

/** Every fixture row, in ladder order. Re-registering replaces in place, so this is idempotent. */
export function registerFixtureModels(): void {
  const big = { contextWindow: 1_000_000, maxOutput: 128_000 } as const;
  registerModel({
    id: 'claude-fable-5-1',
    ...ANTHROPIC,
    ...big,
    inputPerMillion: usd(1_000),
    outputPerMillion: usd(5_000),
    cacheReadPerMillion: usd(25),
    cacheWritePerMillion: usd(1_250),
    cacheMinimumTokens: 512,
    reasoning: { effort: true, adaptive: true, disableThinkingUpTo: 'never' },
  });
  registerModel({
    id: 'claude-opus-5-5',
    ...ANTHROPIC,
    ...big,
    inputPerMillion: usd(400),
    outputPerMillion: usd(2_000),
    cacheReadPerMillion: usd(20),
    cacheWritePerMillion: usd(500),
    cacheMinimumTokens: 512,
    reasoning: { effort: true, adaptive: true, disableThinkingUpTo: 'never' },
  });
  registerModel({
    id: 'claude-opus-5',
    ...ANTHROPIC,
    ...big,
    inputPerMillion: usd(500),
    outputPerMillion: usd(2_500),
    cacheReadPerMillion: usd(50),
    cacheWritePerMillion: usd(625),
    cacheMinimumTokens: 512,
    reasoning: { effort: true, adaptive: true, disableThinkingUpTo: 'high' },
  });
  registerModel({
    id: 'claude-sonnet-5-5',
    ...ANTHROPIC,
    ...big,
    inputPerMillion: usd(200),
    outputPerMillion: usd(1_000),
    cacheReadPerMillion: usd(20),
    cacheWritePerMillion: usd(250),
    cacheMinimumTokens: 512,
    reasoning: {
      effort: true,
      adaptive: true,
      disableThinkingUpTo: 'high',
      disabledThinking: 'between_tools',
    },
  });
  registerModel({
    id: 'claude-sonnet-5',
    ...ANTHROPIC,
    ...big,
    inputPerMillion: usd(200),
    outputPerMillion: usd(1_000),
    cacheReadPerMillion: usd(20),
    cacheWritePerMillion: usd(250),
    cacheMinimumTokens: 1_024,
    reasoning: { effort: true, adaptive: true, disableThinkingUpTo: undefined },
  });
  registerModel({
    id: 'claude-haiku-4-5',
    ...ANTHROPIC,
    contextWindow: 200_000,
    maxOutput: 64_000,
    inputPerMillion: usd(100),
    outputPerMillion: usd(500),
    cacheReadPerMillion: usd(10),
    cacheWritePerMillion: usd(125),
    cacheMinimumTokens: 4_096,
    reasoning: { effort: false, adaptive: false, disableThinkingUpTo: undefined },
  });
  const openAi = (id: string, input: number, output: number, read: number) =>
    registerModel({
      id,
      ...OPENAI,
      inputPerMillion: usd(input),
      outputPerMillion: usd(output),
      cacheReadPerMillion: usd(read),
    });
  openAi('gpt-5.6-sol', 500, 3_000, 50);
  openAi('gpt-5.6-terra', 200, 1_200, 20);
  openAi('gpt-5.6-luna', 20, 120, 2);
}

/**
 * Register the fixture rows before every test of the calling file. A hook, not an import side
 * effect: the registry is process state shared by every file `bun test` runs in one process, so
 * a file that `resetModels()`-ed would otherwise empty it for every file after it.
 */
export function useFixtureModels(): void {
  beforeEach(registerFixtureModels);
}
