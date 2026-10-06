// Single responsibility: the `ai` block of `app.config.ts` — whether and where the app's MCP
// endpoint is mounted. Split from `config.ts`, which sits at its 500-line ceiling; the merge and the
// screen stay there, as `jobs` and `cache` do.

import type { Input } from './config-merge';

export interface McpConfig {
  readonly expose: boolean;
  readonly path: string;
}

/**
 * No `modelEnv`. It named the env KEY holding the model id, "so no model string is baked into the
 * image" — and its only reader was `config.ts`'s own merge, copying input to output. Nothing
 * consumed the merged value, so `modelEnv: 'ANTHROPIC_MODEL'` selected no model: `@ultimat3/ai`
 * reads env for API KEYS only, and the model is `request.model ?? DEFAULT_MODEL`, a compile-time
 * constant in `models.ts`. The exact thing the key existed to prevent is what it delivered.
 * Deleted 2026-08 — pass `model` on the request, or read your own env key and pass it.
 */
export interface AiConfig {
  readonly mcp: McpConfig;
}

/** `mcp` is the only member, and it is NESTED — `Input<AiConfig>` would make it all-or-nothing. */
export interface AiConfigInput {
  readonly mcp?: Input<McpConfig> | undefined;
}
