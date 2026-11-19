// `@ultimat3/entity/internal/memory-tx` — whether a memory transaction's root is still open, for
// `@ultimat3/action`'s settle scope. INTERNAL and a leaf on purpose: the barrel is an app's, and
// `/adapter` (the driver kit) put ten modules into every role's serve graph; this costs one.

export { memoryTxOpen } from './memory-journal';
