// `@ultimat3/seo/adapter`: the `images` port (`ADAPTER_PORTS`) as an adapter author needs it —
// the driver, its request/answer, the built-in's options and the stub error. No installer: the boot
// READS `runtime.ts`'s `images` at `/media/*` (`@ultimat3/cli`'s `serve-web.ts`);
// `builtinImageDriver` stays on `.`.

export { notImplementedDriver } from './errors';
export type {
  BuiltinImageDriverOptions,
  ImageTransformDriver,
  TransformedImage,
  TransformRequest,
} from './image-driver';
