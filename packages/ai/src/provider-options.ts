// Single responsibility: `providerOptions` — the typed bag of wire parameters the framework does not
// model itself, one sub-bag per wire format, screened key by key before any request leaves.
//
// The keys are the WIRE's own names (`top_p`, `service_tier`), never a translated set: a body builder
// spreads a screened bag as it stands, the way it passes a content block through.

import { isJsonObject, renderCauseValue } from '@ultimat3/core';
import { AiRequestInvalidError } from './errors';
import type { SamplingWire } from './sampling';

/** The Messages API's parameters a request may pass through (`anthropicProvider()`). */
export interface AnthropicProviderOptions {
  /** `metadata.user_id`: an opaque per-user id the provider uses for abuse detection. */
  readonly metadata?: { readonly user_id?: string };
  readonly service_tier?: 'auto' | 'standard_only';
}

/** The chat-completions parameters a request may pass through (`openAiProvider()`, any host). */
export interface OpenAiProviderOptions {
  /** 0 to 1. Asked for explicitly: a reasoning model in this family may answer it with a 400. */
  readonly top_p?: number;
  /** -2 to 2. */
  readonly frequency_penalty?: number;
  /** -2 to 2. */
  readonly presence_penalty?: number;
  readonly user?: string;
  readonly parallel_tool_calls?: boolean;
  readonly service_tier?: 'auto' | 'default' | 'flex' | 'priority';
}

/**
 * One bag per wire format; each provider reads its own wire's and never another's, so one request
 * carries both when its `fallbackModels` cross formats.
 */
export interface ProviderOptions {
  readonly anthropic?: AnthropicProviderOptions;
  readonly openai?: OpenAiProviderOptions;
}

type Rule =
  | { readonly kind: 'number'; readonly min: number; readonly max: number }
  | { readonly kind: 'string' }
  | { readonly kind: 'boolean' }
  | { readonly kind: 'enum'; readonly values: readonly string[] }
  | { readonly kind: 'object'; readonly fields: Readonly<Record<string, Rule>> };

type RulesOf<T> = { readonly [K in keyof Required<T>]-?: Rule };

// Typed against the interfaces: a key one adds without the other is a type error, both ways.
const RULES: { readonly [W in SamplingWire]-?: RulesOf<Required<ProviderOptions>[W]> } = {
  anthropic: {
    metadata: { kind: 'object', fields: { user_id: { kind: 'string' } } },
    service_tier: { kind: 'enum', values: ['auto', 'standard_only'] },
  },
  openai: {
    frequency_penalty: { kind: 'number', min: -2, max: 2 },
    parallel_tool_calls: { kind: 'boolean' },
    presence_penalty: { kind: 'number', min: -2, max: 2 },
    service_tier: { kind: 'enum', values: ['auto', 'default', 'flex', 'priority'] },
    top_p: { kind: 'number', min: 0, max: 1 },
    user: { kind: 'string' },
  },
};

const WIRES = Object.keys(RULES) as SamplingWire[];

/** Every key each wire takes, sorted — what the README's table and a refusal list. */
export const PROVIDER_OPTION_KEYS: { readonly [W in SamplingWire]: readonly string[] } = {
  anthropic: Object.keys(RULES.anthropic).sort(),
  openai: Object.keys(RULES.openai).sort(),
};

const refuse = (detail: string, fix: string): never => {
  throw new AiRequestInvalidError({ detail, fix });
};

const FIX = (wire: string, key: string): string =>
  `providerOptions: { ${wire}: { ${key}: <value> } }   # one of: ${PROVIDER_OPTION_KEYS[wire as SamplingWire]?.join(', ') ?? WIRES.join(', ')} — or drop the key`;

function screenValue(path: string, wire: string, key: string, rule: Rule, value: unknown): void {
  const shown = renderCauseValue(value);
  switch (rule.kind) {
    case 'number':
      if (typeof value !== 'number' || !(value >= rule.min && value <= rule.max)) {
        refuse(
          `providerOptions.${path} is ${shown}; it must be a number from ${rule.min} to ${rule.max}`,
          FIX(wire, key),
        );
      }
      return;
    case 'string':
    case 'boolean':
      if (typeof value !== rule.kind) {
        refuse(`providerOptions.${path} is ${shown}; it must be a ${rule.kind}`, FIX(wire, key));
      }
      return;
    case 'enum':
      if (typeof value !== 'string' || !rule.values.includes(value)) {
        refuse(
          `providerOptions.${path} is ${shown}; it must be one of ${rule.values.join(', ')}`,
          FIX(wire, key),
        );
      }
      return;
    case 'object':
      screenFields(path, wire, key, rule.fields, value);
  }
}

function screenFields(
  path: string,
  wire: string,
  key: string,
  fields: Readonly<Record<string, Rule>>,
  bag: unknown,
): void {
  if (!isJsonObject(bag)) {
    refuse(
      `providerOptions.${path} is ${renderCauseValue(bag)}; it must be an object`,
      FIX(wire, key),
    );
    return;
  }
  const known = Object.keys(fields);
  for (const [name, value] of Object.entries(bag)) {
    if (value === undefined) continue;
    const rule = Object.hasOwn(fields, name) ? fields[name] : undefined;
    if (rule === undefined) {
      refuse(
        `providerOptions.${path}.${name} is not a parameter here; it takes ${known.join(', ')}`,
        FIX(wire, key),
      );
      return;
    }
    // A top-level key names itself in the fix; a nested one names the key that holds it.
    screenValue(`${path}.${name}`, wire, path === wire ? name : key, rule, value);
  }
}

/**
 * The whole bag, screened: an unknown wire, an unknown key for its wire, a wrong type or an
 * out-of-range number is `X_AI_REQUEST_INVALID` — before a reservation, before a socket. A bag for a
 * wire no configured provider speaks is NOT refused: a `fallbackModels` chain may cross formats.
 */
export function screenProviderOptions(options: unknown): void {
  if (options === undefined) return;
  if (!isJsonObject(options)) {
    refuse(
      `providerOptions is ${renderCauseValue(options)}; it must be an object keyed by wire format`,
      `providerOptions: { openai: { top_p: 0.9 } }   # keyed by ${WIRES.join(', ')}`,
    );
    return;
  }
  for (const [wire, bag] of Object.entries(options)) {
    if (bag === undefined) continue;
    if (!(WIRES as string[]).includes(wire)) {
      refuse(
        `providerOptions.${wire} names no wire format; the wires are ${WIRES.join(', ')}`,
        `providerOptions: { openai: { top_p: 0.9 } }   # keyed by ${WIRES.join(', ')}`,
      );
    }
    screenFields(wire, wire, wire, RULES[wire as SamplingWire], bag);
  }
}

/**
 * The body fields one wire's bag adds — screened here too, so a provider called directly (no
 * gateway) refuses exactly what the gateway would. The other wires' bags are ignored.
 */
export function providerOptionsBody(
  wire: SamplingWire,
  options: ProviderOptions | undefined,
): Record<string, unknown> {
  const bag = options?.[wire];
  if (bag === undefined) return {};
  screenFields(wire, wire, wire, RULES[wire], bag);
  return Object.fromEntries(Object.entries(bag).filter(([, value]) => value !== undefined));
}
