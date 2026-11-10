// `@ultimat3/render/adapter`: the `isrStore` port (`ADAPTER_PORTS`) as an adapter author needs it —
// `IsrStore` and the entry shapes it keeps. No installer: the boot READS `runtime.ts`'s `isrStore`
// where it builds the ISR controller (`@ultimat3/cli`'s `serve-web.ts`); `memoryIsrStore` and
// `storageIsrStore` stay on `./server`. Types only, so this subpath costs no bundle a byte.

export type { AssetResolver } from './asset';
export type {
  IsrAnswer,
  IsrEntry,
  IsrState,
  IsrStore,
  IsrTagFence,
} from './render-isr-store';
