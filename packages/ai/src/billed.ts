// Single responsibility: what a model call, or a whole run, was BILLED before it failed — the
// shape it travels in on a thrown error's `meta.billed`, the reader a job uses to store it, and
// the arithmetic that adds one call to a run.
//
// It exists because a failure after the provider answered is not free: a truncated answer, tool
// arguments that would not parse, a schema no repair turn satisfied — each was generated and
// charged for. A job that only sees the error would otherwise have to guess what the attempt cost.

import { isUltimateError } from '@ultimat3/core';
import type { Money } from '@ultimat3/money';
import type { TokenUsage } from './provider';

/** The `meta` key every failure after a provider answered carries its bill under. */
export const BILLED_META = 'billed';

export interface Billed {
  /** Summed over every provider call that ANSWERED — the provider's own counts. */
  readonly usage: TokenUsage;
  /** The price of `usage`, rounded up once. */
  readonly cost: Money;
  /** Provider calls that answered and are counted above. */
  readonly calls: number;
  /**
   * Provider calls that were started and never reported usage: aborted by the caller or a
   * deadline, cut mid-stream, or failed in transport. What they cost CANNOT be known from here —
   * a provider may bill the tokens it generated before the socket closed, and usage is the last
   * thing a response carries. Zero means the figures above are the whole bill.
   */
  readonly unsettled: number;
}

const COUNTERS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'] as const;

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

const isScale = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 15;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * What `error` says was billed, or `undefined` when it carries no bill — it was thrown before any
 * provider answered, or it is not one of this package's failures. Total: the value came out of a
 * `catch`, and `meta` is data an app stores and reads back, so every field is checked.
 */
export function billedOf(error: unknown): Billed | undefined {
  if (!isUltimateError(error)) return undefined;
  let raw: unknown;
  try {
    raw = error.meta?.[BILLED_META];
  } catch {
    return undefined;
  }
  const record = asRecord(raw);
  const usage = asRecord(record?.['usage']);
  const cost = asRecord(record?.['cost']);
  if (record === undefined || usage === undefined || cost === undefined) return undefined;
  if (!COUNTERS.every((key) => isCount(usage[key]))) return undefined;
  if (!isCount(cost['minor']) || typeof cost['currency'] !== 'string') return undefined;
  if (!isCount(record['calls']) || !isCount(record['unsettled'])) return undefined;
  return {
    usage: {
      inputTokens: usage['inputTokens'] as number,
      outputTokens: usage['outputTokens'] as number,
      cacheReadTokens: usage['cacheReadTokens'] as number,
      cacheWriteTokens: usage['cacheWriteTokens'] as number,
    },
    // The scale travels with the amount: an exact cost read without it is a million times over.
    cost: {
      minor: cost['minor'],
      currency: cost['currency'],
      ...(isScale(cost['scale']) ? { scale: cost['scale'] } : {}),
    },
    calls: record['calls'],
    unsettled: record['unsettled'],
  };
}

/** One answered call, as a bill. */
export function billedCall(usage: TokenUsage, cost: Money): Billed {
  return { usage, cost, calls: 1, unsettled: 0 };
}
