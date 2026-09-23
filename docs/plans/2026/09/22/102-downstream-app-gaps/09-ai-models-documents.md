# 09 — AI: current model rows, document and image input

> Part of [`overview.md`](overview.md). Depends on: none. Tier: 4.

Rules:
- A built-in model the provider serves is one `registerModel` row plus one `ANTHROPIC_MODEL_IDS`
  entry. The request rules a model enforces are data on its row (`models.ts:57-63`), never an `if`.
- A prompt may carry a PDF or an image as a content block. The provider decides whether it
  accepts one, and a provider that cannot is refused with a code, not a 400.

## Files to change
- `packages/ai/src/models.ts:57-63` — widen `ModelReasoning.disableThinkingUpTo: Effort | undefined | 'never'`.
  - `'never'` means `thinking: 'disabled'` is refused for this model at every effort.
  - `assertDisableAllowed` (`:268-276`) refuses with `AiRequestInvalidError`, fix: "drop `thinking: 'disabled'` and lower `effort` instead".
- `packages/ai/src/models.ts:26-30,285-321` — add a `claude-opus-5-5` row and add it to `ANTHROPIC_MODEL_IDS`.
  - 1M context, 128K output, $4 / $20 per MTok, cache minimum as Opus 5.
  - `reasoning: { effort: true, adaptive: true, disableThinkingUpTo: 'never' }`.
  - Keep `DEFAULT_MODEL = 'claude-opus-5'`: Opus 5.5 is launching and opt-in by name, as of 2026-09.
  - Add a comment that its default effort is `medium`, so `llm()` should send `effort` explicitly when a declaration sets one. It already only sends what was asked (`models.ts:240-264`).
  - Ladder position: first in the Anthropic family.
  - Do **not** add dated ids (`claude-haiku-4-5-20251001`). The alias `claude-haiku-4-5` is registered, and an alias is the rule (`models.ts:278-283`).
- `packages/ai/src/provider.ts:180-213` — `AnthropicProviderInput.models?: readonly ModelId[]`, defaulting to `ANTHROPIC_MODEL_IDS`. It mirrors `OpenAIProvider`'s `config.models` (`openai-provider.ts:105`), so an app can serve a newly released id with `registerModel` plus `models: [...ANTHROPIC_MODEL_IDS, 'new-id']` and no wrapper.
- `packages/ai/src/provider.ts:32-45` — `AiContentBlock` gains:
  - `{ type: 'document'; source: { type: 'base64'; mediaType: 'application/pdf'; data: string } | { type: 'text'; data: string }; title?: string }`
  - `{ type: 'image'; source: { type: 'base64'; mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'; data: string } }`

  `messageText()` (`:56`) renders them as `[document]`/`[image]` for estimation only.
- `packages/ai/src/wire.ts:237` area — map both blocks to the Messages API shape (`document` and `image` with `source.media_type`). Byte caps: 32 MB per request. A block over the cap is refused before the call.
- `packages/ai/src/openai-messages.ts` — images map to `image_url` data URLs. Documents are refused with `X_AI_CONTENT_UNSUPPORTED` until measured.
- `packages/ai/src/llm.ts:243` — `definePrompt` render may return `AiContentBlock[]`. `llm()` passes blocks through unchanged. Estimation (`gateway` budget) counts base64 bytes / 4 × 3 / 750 per page as the conservative token estimate, documented as an estimate.
- `packages/ai/src/errors.ts` — `X_AI_CONTENT_UNSUPPORTED`.
- `packages/ai/README.md` — models table row, §"Documents and images".

## Steps
1. Add the `'never'` rule and the Opus 5.5 row. Add the unit test that `thinking: 'disabled'` on it is refused.
2. Add `models` to `AnthropicProviderInput`.
3. Add the content blocks, the wire mapping and estimation.

## Tests
- `bun test packages/ai/src/models.test.ts packages/ai/src/wire.test.ts packages/ai/src/provider.test.ts packages/ai/src/llm.test.ts`.
- The recorded body for Opus 5.5 with effort `high` carries `output_config.effort` and no `thinking: disabled`.
- A PDF block serialises to `{"type":"document","source":{"type":"base64","media_type":"application/pdf",...}}`, placed before the text block.
- A document sent to the OpenAI provider is `X_AI_CONTENT_UNSUPPORTED`.

## Done when
- `llm({ model: 'claude-opus-5-5', ... })` with a PDF block builds a valid request with no app-side `registerModel` or provider wrapper.
