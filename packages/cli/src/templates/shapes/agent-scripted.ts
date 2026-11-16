// The `agent` shape's test model: the scripted provider every assistant test and the eval run on,
// and the runtime test that holds `runtime.ts` to the environment. No network, no key, no vendor.

import type { GeneratedFile } from '../naming';
import { ASSISTANT_DIR } from './agent-model';

const scriptedModel =
  (): string => `// The model this feature's tests and its eval run on: a scripted one, behind a gateway a test
// swaps in (\`swapAdapter('aiGateway', gateway)\`) — never a network call, never a key. Registered
// when a test asks for it, never at import: the boot scan imports this module too, and production
// must not hold a row it never runs.
import type { Gateway, ScriptedProvider, ScriptedTurn } from '@ultimat3/ai';
import { providerGateway, registerModel, scriptedProvider } from '@ultimat3/ai';

/** A test row: free, so a test's bill reads its token counts and nothing a vendor charges. */
const SCRIPTED = {
  id: 'scripted',
  contextWindow: 32_000,
  maxOutput: 4_096,
  inputPerMillion: { minor: 0, currency: 'USD' },
  outputPerMillion: { minor: 0, currency: 'USD' },
  cacheMinimumTokens: 0,
  reasoning: { effort: false, adaptive: false, disableThinkingUpTo: undefined },
} as const;

/** A gateway answering \`turns\` in order; one call past the last is X_AI_SCRIPT_EXHAUSTED. */
export function scriptedGateway(turns: readonly ScriptedTurn[]): {
  readonly model: ScriptedProvider;
  readonly gateway: Gateway;
} {
  const model = scriptedProvider({ turns });
  registerModel(SCRIPTED);
  return { model, gateway: providerGateway({ providers: [model], defaultModel: SCRIPTED.id }) };
}
`;

const runtimeTest =
  (): string => `// The runtime loads under test, and installs a model gateway exactly when the environment names a
// model (\`app/assistant/model.ts\`) — under \`bun test\` with no LLM_MODEL, nothing at all.
import { expect, unitTest } from '@ultimat3/testing';
import { runtime } from './runtime';

unitTest('the runtime holds a gateway only when LLM_MODEL names a model', () => {
  const named = (Bun.env.LLM_MODEL ?? '') !== '';
  // The gateway's presence, not the key list: \`x g sign-in --oidc\` adds \`routes\` beside it.
  expect('aiGateway' in runtime).toBe(named);
});
`;

/** The scripted model, and the runtime test that replaces the base one. */
export function scriptedFiles(): readonly GeneratedFile[] {
  return [
    { path: `${ASSISTANT_DIR}/scripted-model.ts`, contents: scriptedModel() },
    { path: 'apps/web/runtime.test.ts', contents: runtimeTest() },
  ];
}
