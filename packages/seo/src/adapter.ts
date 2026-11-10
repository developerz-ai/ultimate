// `@ultimat3/seo/adapter`: the `images` port (`ADAPTER_PORTS`) as an adapter author needs it —
// `ImageTransformDriver`, what it is asked and what it answers. No installer: the boot READS
// `runtime.ts`'s `images` where it mounts `/media/*` (`@ultimat3/cli`'s `serve-web.ts`);
// `builtinImageDriver` stays on `.`. Types only.

export type {
  ImageTransformDriver,
  TransformedImage,
  TransformRequest,
} from './image-driver';
