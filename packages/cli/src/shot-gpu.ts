// The GPU backend the photographed page could reach, read from `navigator.gpu` inside the page.
// A WebGPU canvas that came out blank on a headless machine with no adapter is a fact about the
// machine, not the app — and a picture alone cannot tell the two apart. Recorded, never gating.

import type { StandardSchemaV1 } from '@ultimat3/schema';
import { t, validate } from '@ultimat3/schema';
import type { JsonValue } from './output';

export interface ShotGpu {
  /** `navigator.gpu` exists — the browser exposes WebGPU at all. */
  readonly api: boolean;
  /** `requestAdapter()` answered an adapter: WebGPU is usable on this page, on this machine. */
  readonly available: boolean;
  /** The adapter's `info` (vendor, architecture, device, description), or `null` with none. */
  readonly adapter: string | null;
  /** A software adapter (SwiftShader and kin): it renders, at a speed no user sees. */
  readonly fallback: boolean;
}

/**
 * An expression, never a closure: `CdpPageLike.evaluate` takes the string form and awaits the
 * promise. `requestAdapter()` is raced against a bound so a browser that never answers cannot
 * hold a capture whose picture is already taken. `adapter.info` is current Chrome; older ones
 * spell the flag `isFallbackAdapter` on the adapter, which is why both are read.
 */
export const GPU_PROBE =
  '(async function(){var g=navigator.gpu;' +
  'if(!g)return{api:false,available:false,adapter:null,fallback:false};var a=null;' +
  'try{a=await Promise.race([g.requestAdapter(),' +
  'new Promise(function(r){setTimeout(function(){r(null);},2000);})]);}catch(e){a=null;}' +
  'if(!a)return{api:true,available:false,adapter:null,fallback:false};var i=a.info||{};' +
  'var n=[i.vendor,i.architecture,i.device,i.description].filter(function(s){return !!s;})' +
  '.join(" ");return{api:true,available:true,adapter:n===""?null:n,' +
  'fallback:!!(a.isFallbackAdapter||i.isFallbackAdapter)};})()';

const gpuProbeSchema: StandardSchemaV1<unknown, ShotGpu> = t.object({
  api: t.boolean,
  available: t.boolean,
  adapter: t.nullable(t.string),
  fallback: t.boolean,
}) as unknown as StandardSchemaV1<unknown, ShotGpu>;

/** Parsed, never cast: a page can answer anything. `null` for a shape that does not fit. */
export function parseGpuProbe(value: unknown): ShotGpu | null {
  const result = validate(gpuProbeSchema, value);
  return result.issues === undefined ? result.value : null;
}

/** `null` when the page refused the probe — "not read" is never reported as "no GPU". */
export const readShotGpu = (page: {
  evaluate(expression: string): Promise<unknown>;
}): Promise<ShotGpu | null> =>
  page
    .evaluate(GPU_PROBE)
    .then(parseGpuProbe)
    .catch(() => null);

export const gpuJson = (gpu: ShotGpu | null | undefined): JsonValue =>
  gpu === null || gpu === undefined
    ? null
    : { api: gpu.api, available: gpu.available, adapter: gpu.adapter, fallback: gpu.fallback };
