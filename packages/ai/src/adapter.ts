// `@ultimat3/ai/adapter` — the `aiGateway` port: the interface a gateway implements, the request
// and answer shapes it speaks, the errors a gateway driver throws, and the boot's installer. The
// installer is here and never on the `.` barrel; the boot fills it from `apps/<app>/runtime.ts`.

export type { BudgetKeys, BudgetLedger } from './budget';
export {
  AiKeyMissingError,
  AiModelUnknownError,
  AiProviderUnavailableError,
  AiRequestInvalidError,
} from './errors';
export type { Gateway } from './gateway';
export type { ModelId } from './models';
export type { GenerateRequest, GenerateResult, StreamChunk } from './provider';
export { installAiGateway } from './runtime';
export type { SamplingWire } from './sampling';
