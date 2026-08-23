// Every inline `<script>` body a served process can put in a document, as the `script-src` sources
// that admit it. The mirror of `style-csp.ts`, and needed for the same reason: `script-src` was
// `'self' 'wasm-unsafe-eval'` while every document carrying an island shipped the hydration runtime
// INLINE, so under the enforced policy a container serves (`dev: false`) no island ever booted —
// invisible in `x dev`, where the policy is report-only.

import { cspHashSource } from '@ultimat3/http';
import { HYDRATE_RUNTIME_BODIES } from '@ultimat3/render';

/**
 * Hashes, never a nonce: a `render: 'static'` page is a file on disk, so no per-response value can
 * reach it. Read from `@ultimat3/render`'s own enumeration rather than restated here — the body
 * the document carries and the body the policy hashes have to be one string.
 */
export function inlineScriptSources(): readonly string[] {
  return [...new Set(HYDRATE_RUNTIME_BODIES.map(cspHashSource))].sort();
}
