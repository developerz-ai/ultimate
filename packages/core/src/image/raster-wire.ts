// Single responsibility: what crosses the raster Worker's boundary, both ways — the request, the
// answer, and a coded error flattened to a clonable record and rebuilt as the SAME class on the
// other side, so `instanceof ImageUnsupportedError` holds whichever thread raised it.

import { renderThrowable } from '../error-render';
import { isUltimateError, UltimateError } from '../errors';
import { isJsonObject } from '../json-object';
import {
  ImageDecodeFailedError,
  ImageRasterBudgetError,
  ImageTooLargeError,
  ImageUnsupportedError,
} from './errors';
import type { ImageTransformSpec } from './transform-inline';

export interface RasterRequest {
  readonly id: number;
  readonly bytes: Uint8Array;
  readonly spec: ImageTransformSpec;
}

export interface WireError {
  readonly code: string;
  readonly cause: string;
  readonly fix: string;
  readonly meta?: Readonly<Record<string, unknown>> | undefined;
}

export type RasterAnswer =
  | { readonly id: number; readonly ok: true; readonly bytes: Uint8Array }
  | { readonly id: number; readonly ok: false; readonly error: WireError };

/**
 * The spec's FIELDS are not checked here: `transformInline` screens every one of them (dimension,
 * padding, colour, quality, format) and refuses with its own code — a second screen would be a
 * second set of messages for the same mistakes.
 */
export function isRasterRequest(value: unknown): value is RasterRequest {
  return (
    isJsonObject(value) &&
    typeof value['id'] === 'number' &&
    value['bytes'] instanceof Uint8Array &&
    isJsonObject(value['spec'])
  );
}

/** The Worker's first message: its module evaluated, so it is a Worker that can answer. */
export const RASTER_READY = Object.freeze({ ready: true });

export function isRasterReady(value: unknown): boolean {
  return isJsonObject(value) && value['ready'] === true;
}

export function isRasterAnswer(value: unknown): value is RasterAnswer {
  if (!isJsonObject(value) || typeof value['id'] !== 'number') return false;
  if (value['ok'] === true) return value['bytes'] instanceof Uint8Array;
  return value['ok'] === false && isWireError(value['error']);
}

function isWireError(value: unknown): value is WireError {
  return (
    isJsonObject(value) &&
    typeof value['code'] === 'string' &&
    typeof value['cause'] === 'string' &&
    typeof value['fix'] === 'string' &&
    (value['meta'] === undefined || isJsonObject(value['meta']))
  );
}

/** A thrown value as a record `postMessage` can clone. Uncoded is a defect: `X_INTERNAL`. */
export function wireError(error: unknown): WireError {
  if (isUltimateError(error)) {
    return { code: error.code, cause: error.cause, fix: error.fix, meta: error.meta };
  }
  return {
    code: 'X_INTERNAL',
    cause: `the raster worker threw an uncoded ${renderThrowable(error)}`,
    fix: 'bun test ./packages/core/src/image/   # an uncoded throw in the transform is a framework defect; the failing case names it',
  };
}

type ImageErrorClass = new (
  cause: string,
  fix: string,
  meta?: Readonly<Record<string, unknown>>,
) => UltimateError;

const IMAGE_CLASSES: Readonly<Record<string, ImageErrorClass>> = {
  [ImageDecodeFailedError.code]: ImageDecodeFailedError,
  [ImageRasterBudgetError.code]: ImageRasterBudgetError,
  [ImageTooLargeError.code]: ImageTooLargeError,
  [ImageUnsupportedError.code]: ImageUnsupportedError,
};

/** The record rebuilt on this side: an image code as its own class, any other as its code. */
export function errorFromWire(wire: WireError): UltimateError {
  const imageClass = Object.hasOwn(IMAGE_CLASSES, wire.code) ? IMAGE_CLASSES[wire.code] : undefined;
  if (imageClass !== undefined) return new imageClass(wire.cause, wire.fix, wire.meta);
  return new UltimateError({ code: wire.code, cause: wire.cause, fix: wire.fix, meta: wire.meta });
}
