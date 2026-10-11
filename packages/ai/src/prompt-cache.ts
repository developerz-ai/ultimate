// Single responsibility: PROVIDER prompt caching — the neutral request shapes (a system prompt in
// a stable and a per-run part, the hint that asks for the prefix to be cached) and the table that
// says how each wire and host is told. Not the gateway's response cache, not `llm()`'s semantic one.
//
// THE RULE, and where it comes from (both pages read 2026-10-11):
//
//   Anthropic — https://platform.claude.com/docs/en/docs/build-with-claude/prompt-caching
//     "Place `cache_control` directly on individual content blocks"; the shape is
//     `"cache_control": { "type": "ephemeral" }` (5-minute TTL, the default).
//     "Prompt caching references the entire prompt: `tools`, `system`, and `messages` (in that
//     order), up to and including the block designated with `cache_control`."
//     "You can define up to 4 cache breakpoints" — a fifth is a 400.
//     "The system checks at most 20 positions per breakpoint, counting the breakpoint itself."
//     "Shorter prompts cannot be cached, even if marked with `cache_control`. Any requests to cache
//     fewer than this number of tokens will be processed without caching, and no error is
//     returned." Minimums are per model (512 to 4,096 tokens) — `ModelSpec.cacheMinimumTokens`.
//     "5-minute cache write tokens are 1.25 times the base input tokens price … Cache read tokens
//     are 0.1 times the base input tokens price" (0.05x and 0.025x on named models).
//
//   OpenRouter — https://openrouter.ai/docs/features/prompt-caching
//     Anthropic models: `cache_control` on a `text` part inside a message's `content` array;
//     "There is a limit of four explicit breakpoints."
//     Gemini: "Gemini 2.5 series models and newer support implicit caching" with no write cost; an
//     explicit breakpoint is billed as a write (input price plus storage). So: never mark.
//     OpenAI: automatic, no configuration. So: never mark.
//     Stickiness: `session_id` in the body or the `x-session-id` header, at most 256 characters;
//     "Sticky routing is skipped when you set `provider.order`" — this package sends no `provider`
//     object at all, and must not start to.
//     Usage: `prompt_tokens_details.cached_tokens` and `.cache_write_tokens`.
//     https://openrouter.ai/docs/use-cases/usage-accounting: "The `usage: { include: true }` …
//     parameters are deprecated and have no effect" — so it is not sent.
//
//   OpenAI — automatic above 1,024 tokens (the OpenRouter page's summary of it); the body field
//     `prompt_cache_key` groups requests that share a prefix. OpenRouter reads it as a session id
//     when neither `session_id` nor the header is given.
//
//   Checked against the live service, 2026-10-11, `anthropic/claude-sonnet-5.5` on OpenRouter, a
//   three-turn `agent()` run: a mark on a `role: 'tool'` message's text part IS honoured (turn 2
//   read turn 1's 19,914-token prefix and wrote 72), and `prompt_tokens` INCLUDES both the read and
//   the written tokens — which is why ./openai-wire subtracts both.
//
// The table is DATA: a new host or model family is a row. Unknown endpoints get NOTHING — a field
// a self-hosted server has never heard of is a 400 on some of them, and a mark is never worth that.

/**
 * A system prompt in two parts. `stable` is byte-identical across runs — rules, a knowledge-base
 * index — and is what a cache shares BETWEEN runs; `run` is whatever differs per run and comes
 * after it, so it never invalidates the stable half. A cache is a prefix match: one changed byte in
 * `stable` (a timestamp, an unsorted list) is a full-price write on every call.
 */
export interface SystemParts {
  readonly stable: string;
  readonly run?: string;
}

/** A plain string is the whole prompt as one stable part. */
export type SystemPrompt = string | SystemParts;

/**
 * "Cache this request's prefix": present on a `GenerateRequest`, each provider marks the stable
 * system part and the transcript's tail the way its wire wants — or not at all, where the host
 * caches implicitly. Absent, nothing is marked and nothing is sent.
 */
export interface PromptCacheHint {
  /**
   * A key naming the runs that share a prefix, for hosts that route or shard by one (an
   * `x-session-id` header on OpenRouter, `prompt_cache_key` on OpenAI). Never a secret, never
   * personal data: it leaves the process in a header.
   */
  readonly session?: string;
}

/** OpenRouter's documented ceiling on a session id; OpenAI's key is held to the same one. */
export const SESSION_KEY_MAX = 256;

/** The one mark this package sends: the 5-minute TTL, which is the rate `costOf` prices. */
export const CACHE_MARK = { type: 'ephemeral' } as const;

/** Both parts as one text, stable first — for an estimate, and for a wire with one system string. */
export function systemText(system: SystemPrompt | undefined): string {
  if (system === undefined) return '';
  if (typeof system === 'string') return system;
  return [system.stable, system.run ?? ''].filter((part) => part !== '').join('\n\n');
}

/** The parts, normalised: `''` for an absent half, so a wire never sends an empty block. */
export function systemParts(system: SystemPrompt | undefined): Required<SystemParts> {
  if (system === undefined) return { stable: '', run: '' };
  if (typeof system === 'string') return { stable: system, run: '' };
  return { stable: system.stable, run: system.run ?? '' };
}

export type CacheWire = 'anthropic' | 'openai';

export interface PromptCacheRule {
  readonly wire: CacheWire;
  /** A hostname and every subdomain of it; `'*'` is any endpoint on this wire. */
  readonly host: string;
  /** A model-id prefix; `''` is every model. */
  readonly model: string;
  /**
   * `blocks`: `cache_control` on Anthropic content blocks — the stable system block and the last
   * block of the last two messages (three of the four breakpoints; the fourth is left free).
   * `parts`: the same mark on chat-completions content PARTS — the stable system part and the tail
   * message's last part (two breakpoints).
   * `none`: the host caches by itself, or is unknown.
   */
  readonly marks: 'blocks' | 'parts' | 'none';
  /** Where a `PromptCacheHint.session` goes. */
  readonly session: 'x-session-id' | 'prompt_cache_key' | 'none';
}

/** First match wins. */
export const PROMPT_CACHE_RULES: readonly PromptCacheRule[] = [
  { wire: 'anthropic', host: '*', model: '', marks: 'blocks', session: 'none' },
  {
    wire: 'openai',
    host: 'openrouter.ai',
    model: 'anthropic/',
    marks: 'parts',
    session: 'x-session-id',
  },
  // Gemini, OpenAI, and everything else OpenRouter fronts: implicit or automatic. An explicit mark
  // on Gemini turns a free implicit cache into a paid write.
  { wire: 'openai', host: 'openrouter.ai', model: '', marks: 'none', session: 'x-session-id' },
  { wire: 'openai', host: 'api.openai.com', model: '', marks: 'none', session: 'prompt_cache_key' },
];

const NO_RULE: Pick<PromptCacheRule, 'marks' | 'session'> = { marks: 'none', session: 'none' };

/** OpenAI's own endpoint, which is what an `openAiProvider()` with no `baseUrl` talks to. */
const DEFAULT_OPENAI_HOST = 'api.openai.com';

/** The rule for one request. Total: a base URL that does not parse matches no host. */
export function promptCacheRule(
  wire: CacheWire,
  baseUrl: string | undefined,
  model: string,
): Pick<PromptCacheRule, 'marks' | 'session'> {
  const host = baseUrl === undefined ? DEFAULT_OPENAI_HOST : hostOf(baseUrl);
  const found = PROMPT_CACHE_RULES.find(
    (rule) =>
      rule.wire === wire &&
      (rule.host === '*' || host === rule.host || host.endsWith(`.${rule.host}`)) &&
      model.startsWith(rule.model),
  );
  return found ?? NO_RULE;
}

function hostOf(baseUrl: string): string {
  return URL.canParse(baseUrl) ? new URL(baseUrl).hostname.toLowerCase() : '';
}

/**
 * What a declaration writes: `'auto'` marks every request of the call, `'off'` marks none, and the
 * object form is `'auto'` plus a session key — a constant, or derived per call (per org, say).
 */
export type PromptCacheOption<A> =
  | 'auto'
  | 'off'
  | { readonly session: string | ((args: A) => string) };

/** The hint one call sends on every request, or `undefined` for none. */
export function promptCacheHint<A>(
  option: PromptCacheOption<A> | undefined,
  fallback: 'auto' | 'off',
  args: A,
): PromptCacheHint | undefined {
  const chosen = option ?? fallback;
  if (chosen === 'off') return undefined;
  if (chosen === 'auto') return {};
  return { session: typeof chosen.session === 'string' ? chosen.session : chosen.session(args) };
}
