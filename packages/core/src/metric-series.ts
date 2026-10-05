// Single responsibility: one series per label set under an instrument — its stable key, and the
// cardinality ceiling past which every new label set folds into one overflow series, reported once.

import { logger } from './logger';
import { MetricCardinalityError } from './metric-errors';
import { assertLabelNames } from './metric-names';
import type { Instrument, Series } from './metric-registry';
import type { MetricAttributes } from './metrics-types';

/**
 * The label the folded series carries. OTel's own cardinality-limit spelling, deliberately NOT
 * `__overflow`: Prometheus treats `__`-prefixed labels as internal and strips them during
 * relabeling, so an overflow series named that way would merge back into the unlabelled series
 * and the drop would be invisible in exactly the place it has to be visible.
 */
export const OVERFLOW_ATTRIBUTE = 'otel_metric_overflow';

const OVERFLOW_ATTRIBUTES: MetricAttributes = Object.freeze({ [OVERFLOW_ATTRIBUTE]: true });

/**
 * Stable series key: attribute order must not create a second series for one label set, and no
 * label set may spell another one's key.
 *
 * `JSON.stringify` over the sorted pairs, because a DELIMITER cannot carry the second property:
 * the key was the pairs joined by control characters (U+0000 inside a pair, U+0001 between them),
 * and a value holding those bytes IS another set's key — `{ a: 'b\u0001c\u0000d' }` was
 * `{ a: 'b', c: 'd' }`, so the point landed on whichever series arrived first and was exported
 * under labels the caller never passed. Attribute values are app data. Quoting is the only total
 * answer and is not slower: 644 ns/op against the join's 709, on a 3-label set. `String(value)`
 * stays, so `1` and `'1'` are still one series rather than two rows an exporter renders alike.
 */
function seriesKey(attributes: MetricAttributes): string {
  const entries = Object.entries(attributes);
  if (entries.length === 0) return '';
  return JSON.stringify(
    entries.sort(([a], [b]) => (a < b ? -1 : 1)).map(([key, value]) => [key, String(value)]),
  );
}

/**
 * Reported through the logger rather than thrown: the call site is `orderCounter.add(1, …)` deep
 * inside a request, and killing that request would turn a metrics bug into a user-visible outage
 * — which is the same trade `finite()` does NOT make, because a NaN is a caller bug at one call
 * site while this is a design bug the whole instrument shares.
 */
function reportOverflow(instrument: Instrument): void {
  if (instrument.overflowed) return;
  instrument.overflowed = true;
  const { name, kind } = instrument.descriptor;
  const error = new MetricCardinalityError({
    cause: `${name} reached its ceiling of ${instrument.maxSeries} label set(s); every further label set folds into one ${OVERFLOW_ATTRIBUTE}="true" series`,
    fix: `drop the unbounded label from the ${name} call site (an id, a path, an email is never a label), or raise it deliberately: ${kind}('${name}', { maxSeries: ${instrument.maxSeries * 2} })`,
    meta: { metric: name, maxSeries: instrument.maxSeries },
  });
  logger.error(error.format(), { code: error.code, metric: name });
}

function createSeries(instrument: Instrument, key: string, attributes: MetricAttributes): Series {
  const created: Series = {
    attributes,
    value: 0,
    count: 0,
    min: Number.POSITIVE_INFINITY,
    max: Number.NEGATIVE_INFINITY,
    buckets: new Array<number>(instrument.bounds.length + 1).fill(0),
  };
  instrument.series.set(key, created);
  return created;
}

const OVERFLOW_KEY = seriesKey(OVERFLOW_ATTRIBUTES);

export function seriesFor(instrument: Instrument, attributes: MetricAttributes): Series {
  const key = seriesKey(attributes);
  const found = instrument.series.get(key);
  if (found !== undefined) return found;
  // On the MISS, ahead of the ceiling — never inside `createSeries`, which the overflow branch
  // below returns without reaching. A screen that ran only where a series is BORN was a screen
  // that depended on load: `bad"key` threw on a fresh process and was swallowed on a busy one,
  // once the instrument had filled up, which is exactly when an unparseable label is likeliest to
  // arrive. A hit needs no check — a key in the map passed this on the way in.
  assertLabelNames(instrument.descriptor.name, attributes);
  if (instrument.series.size >= instrument.maxSeries) {
    reportOverflow(instrument);
    // Created directly rather than through this function again: the overflow series is the ONE
    // allocation the ceiling does not apply to, and routing it back through the check is an
    // infinite recursion the first time the cap is hit.
    return (
      instrument.series.get(OVERFLOW_KEY) ??
      createSeries(instrument, OVERFLOW_KEY, OVERFLOW_ATTRIBUTES)
    );
  }
  return createSeries(instrument, key, attributes);
}
