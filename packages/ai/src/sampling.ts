// Single responsibility: the two determinism knobs a request may carry — `temperature` and `seed`
// — screened once where they are declared, and written onto a wire body only for a model whose
// row says it takes them.
//
// A row decides, never an `if` in a body builder (the rule `reasoningBody` follows): a reasoning
// model in either family answers a sampling parameter with a 400, and which models those are is
// the app's catalogue. So `ModelSpec.sampling` is the switch, absent means NOT SENT — every row
// that predates it keeps sending exactly what it sent — and an asked-for knob the row does not
// take is left out, not refused: a verifier that asks for `temperature: 0` still runs on a model
// that has no such control, and `ignoredSampling` is what a span says about it.

import { AiRequestInvalidError } from './errors';
import type { ModelId } from './models';
import { modelSpec } from './models';

export interface Sampling {
  /** 0 to 2. `0` is the most repeatable a model offers; it is not a guarantee of determinism. */
  readonly temperature?: number;
  /** A whole number. Honoured by chat-completions endpoints that support it; best effort there. */
  readonly seed?: number;
}

/** Which knobs each wire HAS. The Messages API has no `seed` at all. */
const WIRE_KNOBS = {
  openai: ['temperature', 'seed'],
  anthropic: ['temperature'],
} as const;

export type SamplingWire = keyof typeof WIRE_KNOBS;

/** A declaration's knobs, screened: a `NaN` temperature or a fractional seed is a 400 mid-run. */
export function screenSampling(subject: string, sampling: Sampling): Sampling {
  const { temperature, seed } = sampling;
  if (
    temperature !== undefined &&
    !(Number.isFinite(temperature) && temperature >= 0 && temperature <= 2)
  ) {
    throw new AiRequestInvalidError({
      detail: `${subject} temperature is ${String(temperature)}; it must be a number from 0 to 2`,
      fix: `temperature: 0   # on the ${subject}() declaration — 0 to 2, or drop the key`,
    });
  }
  if (seed !== undefined && !Number.isSafeInteger(seed)) {
    throw new AiRequestInvalidError({
      detail: `${subject} seed is ${String(seed)}; it must be a whole number`,
      fix: `seed: 7   # on the ${subject}() declaration — a whole number, or drop the key`,
    });
  }
  return {
    ...(temperature === undefined ? {} : { temperature }),
    ...(seed === undefined ? {} : { seed }),
  };
}

/** The body fields for the knobs this request asks for AND this model, on this wire, takes. */
export function samplingBody(
  wire: SamplingWire,
  model: ModelId,
  request: Sampling,
): Record<string, number> {
  const accepts = modelSpec(model).sampling;
  const body: Record<string, number> = {};
  for (const knob of WIRE_KNOBS[wire]) {
    const value = request[knob];
    if (value !== undefined && accepts?.[knob] === true) body[knob] = value;
  }
  return body;
}

/** The knobs a request asked for that no wire will send to `model` — what a span reports. */
export function ignoredSampling(
  model: ModelId,
  request: Sampling,
  /** The wire formats of the providers serving `model`, when the gateway can say. */
  wires?: readonly SamplingWire[],
): readonly string[] {
  const accepts = modelSpec(model).sampling;
  // A knob no serving wire has a word for is dropped too — `seed` on the Messages API.
  const sendable = (knob: 'temperature' | 'seed'): boolean =>
    wires === undefined ||
    wires.length === 0 ||
    wires.some((wire) => (WIRE_KNOBS[wire] as readonly string[]).includes(knob));
  return (['temperature', 'seed'] as const).filter(
    (knob) => request[knob] !== undefined && (accepts?.[knob] !== true || !sendable(knob)),
  );
}
