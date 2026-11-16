// The `agent` shape's model half: the environment keys that name the model, the module that turns
// them into a gateway (or into none), and the scripted model every test and the eval run on. No
// model id, price or endpoint is spelled here or in what this writes — the environment holds them.

import { ENV_EXAMPLE_PATH, type EnvSchema } from '@ultimat3/core';
import type { GeneratedFile } from '../naming';
import { envExampleSource, envSchemaSource, SCAFFOLD_ENV_SCHEMA } from '../scaffold-env';
import type { ShapeEdit } from './overlay';

export const ASSISTANT_DIR = 'apps/web/app/assistant';

/**
 * Every key optional at boot: an app with none of them set boots, tests and gates. `model.ts`
 * requires the first eight once `LLM_MODEL` is set, so a half-named model fails the boot naming
 * each missing key (`X_ENV_MISSING`) rather than at the first call. Descriptions stay under ~80
 * characters, for the reason `SCAFFOLD_ENV_SCHEMA`'s do.
 */
export const MODEL_ENV_SCHEMA = {
  LLM_MODEL: {
    type: 'string',
    required: false,
    description: 'The model id every agent runs on. Unset: no model, every call refused.',
  },
  LLM_BASE_URL: {
    type: 'url',
    required: false,
    description: 'A chat-completions endpoint serving LLM_MODEL, e.g. http://localhost:11434/v1',
  },
  LLM_API_KEY: {
    type: 'string',
    required: false,
    secret: true,
    description: 'The bearer key LLM_BASE_URL takes.',
  },
  LLM_FALLBACK_URL: {
    type: 'url',
    required: false,
    description: 'A second endpoint serving LLM_MODEL, asked when the first is down.',
  },
  LLM_FALLBACK_API_KEY: {
    type: 'string',
    required: false,
    secret: true,
    description: 'The bearer key LLM_FALLBACK_URL takes. Unset: LLM_API_KEY.',
  },
  LLM_CONTEXT_WINDOW: {
    type: 'integer',
    required: false,
    min: 1,
    description: 'Tokens LLM_MODEL reads per request, from its vendor page.',
  },
  LLM_MAX_OUTPUT: {
    type: 'integer',
    required: false,
    min: 1,
    description: 'Tokens LLM_MODEL writes per answer, from its vendor page.',
  },
  LLM_INPUT_PER_MILLION: {
    type: 'integer',
    required: false,
    min: 0,
    description: 'Price of a million input tokens, in integer minor units of LLM_CURRENCY.',
  },
  LLM_OUTPUT_PER_MILLION: {
    type: 'integer',
    required: false,
    min: 0,
    description: 'Price of a million output tokens, in integer minor units of LLM_CURRENCY.',
  },
  LLM_CURRENCY: {
    type: 'string',
    required: false,
    description: 'The ISO 4217 code both prices are in, e.g. EUR.',
  },
} satisfies EnvSchema;

const APP_ENV: EnvSchema = { ...SCAFFOLD_ENV_SCHEMA, ...MODEL_ENV_SCHEMA };

const model = (): string => `/**
 * The model every agent in this app runs on, named by the environment and nowhere else: no model
 * id, no price and no endpoint is spelled in code. \`LLM_MODEL\` unset installs no gateway, and the
 * first model call is refused with X_AI_GATEWAY_MISSING and its fix — so the app boots, tests and
 * gates with no key at all. The tests run on \`scripted-model.ts\`.
 *
 * Set, it is ONE row in the model registry, priced from the environment, served by any endpoint
 * speaking the chat-completions format (\`LLM_BASE_URL\`) and, when \`LLM_FALLBACK_URL\` is set, by
 * a second one the gateway falls over to when the first is down — a fallback between providers
 * serving one model, never a silent swap to another model.
 */

import type { AiFetch, Gateway } from '@ultimat3/ai';
import { openAiProvider, providerGateway, registerModel } from '@ultimat3/ai';
import { defineEnv, type EnvSchema, type EnvVarDecl } from '@ultimat3/core';
import { envSchema } from '../../../../app.config';

type Source = Readonly<Record<string, string | undefined>>;

/** \`app.config.ts\`'s declaration, made required: one list of keys, read twice. */
const need = <D extends EnvVarDecl>(decl: D): Omit<D, 'required'> => {
  const { required: _optional, ...required } = decl;
  return required;
};

const modelEnv = {
  LLM_MODEL: need(envSchema.LLM_MODEL),
  LLM_BASE_URL: need(envSchema.LLM_BASE_URL),
  LLM_API_KEY: need(envSchema.LLM_API_KEY),
  LLM_FALLBACK_URL: envSchema.LLM_FALLBACK_URL,
  LLM_FALLBACK_API_KEY: envSchema.LLM_FALLBACK_API_KEY,
  LLM_CONTEXT_WINDOW: need(envSchema.LLM_CONTEXT_WINDOW),
  LLM_MAX_OUTPUT: need(envSchema.LLM_MAX_OUTPUT),
  LLM_INPUT_PER_MILLION: need(envSchema.LLM_INPUT_PER_MILLION),
  LLM_OUTPUT_PER_MILLION: need(envSchema.LLM_OUTPUT_PER_MILLION),
  LLM_CURRENCY: need(envSchema.LLM_CURRENCY),
} satisfies EnvSchema;

/** \`fetch\` is the seam a test hands in, so the wiring is proved with no network. */
export interface ModelSeams {
  readonly fetch?: AiFetch;
}

/**
 * The endpoints serving the model, primary first: the order the gateway asks them in. A missing
 * or malformed key throws X_ENV_MISSING naming every one, before anything is registered.
 */
export function modelProviders(source: Source, seams: ModelSeams = {}) {
  const env = defineEnv(modelEnv, { env: source });
  const currency = env.LLM_CURRENCY;
  const row = registerModel({
    id: env.LLM_MODEL,
    contextWindow: env.LLM_CONTEXT_WINDOW,
    maxOutput: env.LLM_MAX_OUTPUT,
    inputPerMillion: { minor: env.LLM_INPUT_PER_MILLION, currency },
    outputPerMillion: { minor: env.LLM_OUTPUT_PER_MILLION, currency },
    // No mark is relied on: a chat-completions host caches on its own, or not at all.
    cacheMinimumTokens: 0,
    // No effort or thinking control is sent: a model that takes one is a row you write by hand.
    reasoning: { effort: false, adaptive: false, disableThinkingUpTo: undefined },
  });
  const endpoint = (name: string, baseUrl: string, apiKey: string) =>
    openAiProvider({ name, baseUrl, apiKey, models: [row.id], ...seams });
  const primary = endpoint('primary', env.LLM_BASE_URL, env.LLM_API_KEY);
  if (env.LLM_FALLBACK_URL === undefined) return { model: row.id, providers: [primary] };
  const fallbackKey = env.LLM_FALLBACK_API_KEY ?? env.LLM_API_KEY;
  const fallback = endpoint('fallback', env.LLM_FALLBACK_URL, fallbackKey);
  return { model: row.id, providers: [primary, fallback] };
}

/** The gateway the environment names, or \`undefined\` when \`LLM_MODEL\` names nothing. */
export function modelGateway(source: Source, seams: ModelSeams = {}): Gateway | undefined {
  if ((source.LLM_MODEL ?? '') === '') return undefined;
  const { model, providers } = modelProviders(source, seams);
  return providerGateway({ providers, defaultModel: model });
}

/** What \`apps/web/runtime.ts\` spreads: the gateway when there is one, nothing when there is none. */
export function modelRuntime(source: Source): { readonly aiGateway?: Gateway } {
  const gateway = modelGateway(source);
  return gateway === undefined ? {} : { aiGateway: gateway };
}
`;

const modelTest =
  (): string => `// The model the environment names: none, half of one, one, and one with a fallback endpoint.
// Every request goes to a \`fetch\` double — no network, no key.
import type { AiFetch } from '@ultimat3/ai';
import { modelSpec } from '@ultimat3/ai';
import { expect, unitTest } from '@ultimat3/testing';
import { modelGateway, modelProviders, modelRuntime } from './model';

const named = {
  LLM_MODEL: 'house-model',
  LLM_BASE_URL: 'http://primary.test/v1',
  LLM_API_KEY: 'primary-key',
  LLM_CONTEXT_WINDOW: '32000',
  LLM_MAX_OUTPUT: '4096',
  LLM_INPUT_PER_MILLION: '150',
  LLM_OUTPUT_PER_MILLION: '600',
  LLM_CURRENCY: 'EUR',
};

/** Each URL and bearer the providers sent, answered with a refusal so nothing is parsed. */
const recorder = () => {
  const sent: { url: string; auth: string | null }[] = [];
  const fetch: AiFetch = async (url, init) => {
    sent.push({ url, auth: new Headers(init.headers).get('authorization') });
    return new Response('{}', { status: 400 });
  };
  return { sent, fetch };
};

const ask = { model: 'house-model', messages: [{ role: 'user' as const, content: 'hi' }] };

unitTest('no LLM_MODEL is no gateway: the app boots, and the first call says what to set', () => {
  expect(modelGateway({})).toBeUndefined();
  expect(modelRuntime({ LLM_MODEL: '' })).toEqual({});
});

unitTest('a model named without its numbers is refused, naming every missing key', () => {
  let refused: unknown;
  try {
    modelGateway({ LLM_MODEL: 'house-model' });
  } catch (error) {
    refused = error;
  }
  expect(refused).toBeUltimateError('X_ENV_MISSING');
  expect(String((refused as { cause?: unknown }).cause)).toContain('LLM_CURRENCY');
});

unitTest('a named model is registered at the prices the environment states', () => {
  expect(modelRuntime(named).aiGateway?.defaultModel).toBe('house-model');
  const spec = modelSpec('house-model');
  expect(spec.inputPerMillion).toEqual({ minor: 150, currency: 'EUR' });
  expect(spec.outputPerMillion).toEqual({ minor: 600, currency: 'EUR' });
  expect([spec.contextWindow, spec.maxOutput]).toEqual([32000, 4096]);
});

unitTest('one endpoint without a fallback, called with its own key', async () => {
  const { sent, fetch } = recorder();
  const { providers } = modelProviders(named, { fetch });
  expect(providers.map((provider) => provider.name)).toEqual(['primary']);
  await providers[0]?.generate({ ...ask, maxTokens: 16 }).catch(() => undefined);
  expect(sent).toEqual([
    { url: 'http://primary.test/v1/chat/completions', auth: 'Bearer primary-key' },
  ]);
});

unitTest('a fallback endpoint is asked second, with its own key or the primary one', async () => {
  const { sent, fetch } = recorder();
  const fallback = { ...named, LLM_FALLBACK_URL: 'http://fallback.test/v1' };
  const shared = modelProviders(fallback, { fetch }).providers;
  expect(shared.map((provider) => provider.name)).toEqual(['primary', 'fallback']);
  await shared[1]?.generate({ ...ask, maxTokens: 16 }).catch(() => undefined);
  const own = modelProviders({ ...fallback, LLM_FALLBACK_API_KEY: 'fallback-key' }, { fetch });
  await own.providers[1]?.generate({ ...ask, maxTokens: 16 }).catch(() => undefined);
  expect(sent).toEqual([
    { url: 'http://fallback.test/v1/chat/completions', auth: 'Bearer primary-key' },
    { url: 'http://fallback.test/v1/chat/completions', auth: 'Bearer fallback-key' },
  ]);
});
`;

/** The commented-out port the base runtime writes, replaced by the one this shape installs. */
const RUNTIME_PORT =
  "  // aiGateway: myGateway, // Gateway from '@ultimat3/ai/adapter'; default: none: the first model call is refused (X_AI_GATEWAY_MISSING)\n";
const RUNTIME_IMPORT = "import type { RuntimeOverrides } from '@ultimat3/cli/serve';\n";

/** `app.config.ts` declares the model keys; `runtime.ts` installs the gateway they name. */
export const modelEdits = (): readonly ShapeEdit[] => [
  { path: 'app.config.ts', find: envSchemaSource(), replace: envSchemaSource(APP_ENV) },
  {
    path: 'apps/web/runtime.ts',
    find: RUNTIME_IMPORT,
    replace: `${RUNTIME_IMPORT}import { modelRuntime } from './app/assistant/model';\n`,
  },
  {
    path: 'apps/web/runtime.ts',
    find: RUNTIME_PORT,
    replace:
      '  // The model LLM_MODEL names, or none (app/assistant/model.ts).\n  ...modelRuntime(Bun.env),\n',
  },
];

export function modelFiles(): readonly GeneratedFile[] {
  return [
    { path: `${ASSISTANT_DIR}/model.ts`, contents: model() },
    { path: `${ASSISTANT_DIR}/model.test.ts`, contents: modelTest() },
    // The same renderer `x env example` runs, over the declaration `app.config.ts` now holds.
    { path: ENV_EXAMPLE_PATH, contents: envExampleSource(APP_ENV) },
  ];
}
