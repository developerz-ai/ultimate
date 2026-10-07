// Prompts as versioned artifacts.
//
// A prompt is code, so it gets the same treatment: an id, a declared version, and a content
// hash over everything that changes the model's behaviour. The hash is what makes an eval
// result meaningful — "score 0.94" is worthless unless you can say which exact prompt
// produced it, and a prompt edited in place under the same version silently invalidates
// every score ever recorded against it.
//
// So: edit the template, bump the version. Re-registering a version whose hash moved is a
// build error, not a warning.

import { canonicalJson } from '@ultimat3/core';
import { AiPromptRenderError, AiPromptVersionError } from './errors';
import type { Effort, ModelId, ThinkingMode } from './models';
import { type FencedSpan, fenceMap, neutraliseFenced, SLOT } from './prompt-fence';
import type { JsonSchema } from './tools';

/** Template variables. Values are stringified at render time with no formatting magic. */
export type PromptVars = Readonly<Record<string, string | number | boolean>>;

export interface DefinePromptInput<V extends PromptVars> {
  readonly id: string;
  /** Semver-ish, author-assigned. Must change whenever `template` changes. */
  readonly version: string;
  /**
   * `{{name}}` placeholders. Every key in `V` must appear; unfilled ones throw. A slot inside an
   * XML-style tag pair (`<post_body>\n{{body}}\n</post_body>`) is fenced DATA: render breaks every
   * fence closer in the value, so user text cannot end the fence and pose as instructions.
   */
  readonly template: string;
  /** Optional system prompt. Part of the hash — it changes behaviour. */
  readonly system?: string;
  /** Schema of the variables, for the manifest. */
  readonly input?: JsonSchema;
  /**
   * The output shape this prompt PROMISES. Declarative: it is hashed into `ref` and published by
   * `describePrompts()`, and it is deliberately never sent on the wire — structured output is the
   * `respond` tool `llm()` projects from the ACTION's `output`, and a second path through
   * `output_config.format` / `response_format` is the ambiguity axiom 1 refuses (it is also the
   * one feature most OpenAI-compatible servers do not implement).
   *
   * Editing it moves the hash and so needs a `version` bump, which is the point: a prompt whose
   * promised shape changed is a different prompt, and every score already filed against the old
   * hash describes the old one.
   */
  readonly output?: JsonSchema;
  readonly model?: ModelId;
  readonly effort?: Effort;
  readonly thinking?: ThinkingMode;
  /** Phantom marker so `V` is inferable from a call site that passes no runtime value. */
  readonly vars?: (vars: V) => void;
}

export interface Prompt<V extends PromptVars = PromptVars> {
  readonly id: string;
  readonly version: string;
  /** sha256 over id + version + system + template + schemas + model settings. */
  readonly hash: string;
  readonly template: string;
  readonly system: string | undefined;
  readonly input: JsonSchema | undefined;
  readonly output: JsonSchema | undefined;
  readonly model: ModelId | undefined;
  readonly effort: Effort | undefined;
  readonly thinking: ThinkingMode | undefined;
  /**
   * Substitute variables. In a fenced slot every fence closer the template draws is broken, never
   * deleted (`prompt-fence.ts`). Throws on an unfilled placeholder.
   */
  render(vars: V): string;
  /** `id@version` — the identity an eval result is filed under. */
  readonly ref: string;
}

const registry = new Map<string, Prompt>();

export function definePrompt<V extends PromptVars>(input: DefinePromptInput<V>): Prompt<V> {
  const hash = promptHash(input);
  const key = `${input.id}@${input.version}`;
  const existing = registry.get(key);
  if (existing !== undefined && existing.hash !== hash) {
    throw new AiPromptVersionError({
      id: input.id,
      requested: input.version,
      available: [...registry.keys()].filter((k) => k.startsWith(`${input.id}@`)),
    });
  }

  // Read once, at declaration: the fences are the template's, and a render is a hot path.
  const fences = fenceMap(input.template);
  const prompt: Prompt<V> = {
    id: input.id,
    version: input.version,
    hash,
    template: input.template,
    system: input.system,
    input: input.input,
    output: input.output,
    model: input.model,
    effort: input.effort,
    thinking: input.thinking,
    ref: key,
    render: (vars) => render(input.template, vars, key, fences),
  };
  registry.set(key, prompt as Prompt);
  return prompt;
}

/** Look one up by id and version. Throws with the available versions listed. */
export function getPrompt(id: string, version: string): Prompt {
  const found = registry.get(`${id}@${version}`);
  if (found === undefined) {
    throw new AiPromptVersionError({
      id,
      requested: version,
      available: promptVersions(id),
    });
  }
  return found;
}

export function promptVersions(id: string): readonly string[] {
  return [...registry.values()]
    .filter((p) => p.id === id)
    .map((p) => p.version)
    .sort();
}

/** Every registered prompt, stably ordered — consumed by `x manifest`. */
export function describePrompts(): readonly Prompt[] {
  return [...registry.values()].sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
}

/** Test-only reset. Module-level registries otherwise leak between test files. */
export function resetPrompts(): void {
  registry.clear();
}

function render(
  template: string,
  vars: PromptVars,
  ref: string,
  fences: ReadonlyMap<number, readonly string[]>,
): string {
  const missing: string[] = [];
  const spans: FencedSpan[] = [];
  let names: readonly string[] = [];
  let out = '';
  let from = 0;
  // Assembled by hand rather than `replace`: the fence pass below needs where each fenced value
  // LANDED, because a closer can be built across two values or a value and the template beside it.
  for (const match of template.matchAll(SLOT)) {
    out += template.slice(from, match.index);
    from = match.index + match[0].length;
    const name = match[1] ?? '';
    // `Object.hasOwn`, never `vars[name] === undefined`: a plain object inherits `constructor`,
    // `toString` and `valueOf`, so `{{constructor}}` in a template rendered JS SOURCE into the
    // prompt instead of raising the unfilled-slot error this file promises — and that source was
    // then hashed into the semantic cache key and paid for at the input rate. The discriminator
    // `@ultimat3/flags`' `subject.ts` already uses, for the same reason.
    const value = Object.hasOwn(vars, name) ? vars[name] : undefined;
    if (value === undefined) {
      missing.push(name);
      continue;
    }
    const text = String(value);
    const fenced = fences.get(match.index);
    if (fenced !== undefined) {
      spans.push({ start: out.length, end: out.length + text.length });
      names = fenced;
    }
    out += text;
  }
  out += template.slice(from);
  if (missing.length > 0) {
    // Loud, like an i18n miss: a silently blank variable is a prompt that reads fine and
    // means something else.
    throw new AiPromptRenderError({ ref, missing });
  }
  // A fenced slot is data; no closer a value wrote any part of survives.
  return neutraliseFenced(out, spans, names);
}

/**
 * Canonical serialisation then sha256, over `@ultimat3/core`'s `canonicalJson` — the framework's
 * one INJECTIVE form, so a schema that changed cannot hash as the schema it replaced. A local
 * sorted-key `JSON.stringify` was here and spelled `-0` as `0` and every non-finite number as
 * `null`, which is a `default` the model is told about moving under a ref that did not: every eval
 * score already filed goes on claiming to describe the new prompt.
 *
 * An absent schema stays the empty string rather than becoming `canonicalJson(undefined)`'s
 * `null` — that is what keeps every hash already recorded in a baseline the same value.
 */
export function promptHash<V extends PromptVars>(input: DefinePromptInput<V>): string {
  const fields = [
    `id:${input.id}`,
    `version:${input.version}`,
    `system:${input.system ?? ''}`,
    `template:${input.template}`,
    `input:${schemaField(input.input)}`,
    `output:${schemaField(input.output)}`,
    `model:${input.model ?? ''}`,
    `effort:${input.effort ?? ''}`,
    `thinking:${input.thinking ?? ''}`,
  ].join('\n');
  const hasher = new Bun.CryptoHasher('sha256');
  hasher.update(fields);
  return hasher.digest('hex').slice(0, 32);
}

const schemaField = (schema: JsonSchema | undefined): string =>
  schema === undefined ? '' : canonicalJson(schema);
