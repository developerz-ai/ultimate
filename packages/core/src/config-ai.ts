// Single responsibility: the `ai` block of `app.config.ts` — whether the app's MCP endpoints are
// mounted. Split from `config.ts`, which sits at its 500-line ceiling; the merge and the
// screen stay there, as `jobs` and `cache` do.

import type { Input } from './config-merge';

/**
 * No `path` (deleted in 25.0.0). It moved endpoint #0 off its own `defineAppMcp({ path })` while
 * that endpoint's RFC 9728 metadata and advertised resource still named the defineAppMcp path —
 * with OAuth on, a client was told of a resource at a URL nothing served. Where an endpoint mounts
 * is `defineAppMcp`'s one fact; a written `ai.mcp.path` is refused (`config-removed.ts`).
 */
export interface McpConfig {
  readonly expose: boolean;
}

/**
 * No `modelEnv` (deleted in 8.0.0; refused by name since 25.0.0, `config-removed.ts`). It named the
 * env KEY holding the model id, "so no model string is baked into the image" — and its only reader
 * was `config.ts`'s own merge, copying input to output, so `modelEnv: 'ANTHROPIC_MODEL'` selected
 * no model: `@ultimat3/ai` reads env for API KEYS only. There is no framework default model either
 * (since 25.0.0): an app names the model on the prompt or on `llm({ model })` — read your own env
 * key and pass it there.
 */
export interface AiConfig {
  readonly mcp: McpConfig;
}

/** `mcp` is the only member, and it is NESTED — `Input<AiConfig>` would make it all-or-nothing. */
export interface AiConfigInput {
  readonly mcp?: Input<McpConfig> | undefined;
}
