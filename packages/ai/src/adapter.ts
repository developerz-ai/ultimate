// `@ultimat3/ai/adapter` — the `aiGateway`, `embedder` and `semanticCache` ports: the interfaces
// an adapter implements, the shapes a gateway speaks, the errors a driver throws, and the boot's
// installers. Installers live here and never on the `.` barrel; the boot fills them from
// `apps/<app>/runtime.ts`.

export type { SemanticCache } from '@ultimat3/cache';
export type { BudgetKeys, BudgetLedger } from './budget';
export type { Embedder } from './embeddings';
export {
  AiEmbedderInvalidError,
  AiKeyMissingError,
  AiModelUnknownError,
  AiProviderUnavailableError,
  AiRequestInvalidError,
} from './errors';
export type { Gateway } from './gateway';
export type { ModelId } from './models';
export type { GenerateRequest, GenerateResult, StreamChunk } from './provider';
export type { SemanticCacheFactory } from './runtime';
export { installAiEmbedder, installAiGateway, installSemanticCache } from './runtime';
export type { SamplingWire } from './sampling';
