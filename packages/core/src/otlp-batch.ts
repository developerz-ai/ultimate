// Single responsibility: the bounded batch queue the per-item OTLP exporters (spans, logs) share —
// at most one POST in flight, drop-OLDEST past `maxQueueSize`, a full batch sent at once and the
// rest on an unref'd timer. One copy, because the span exporter's held 100k spans once.

export interface OtlpBatcherOptions<T> {
  readonly maxBatchSize: number;
  readonly maxQueueSize: number;
  readonly flushIntervalMs: number;
  /** Deliver one batch. Must not reject — `postOtlp` degrades to a log line, and so must this. */
  readonly post: (batch: readonly T[]) => Promise<void>;
}

export interface OtlpBatcher<T> {
  push(item: T): void;
  /** Send whatever is queued now. Resolves once the POSTs settle. */
  flush(): Promise<void>;
  /** Stop the timer and flush. */
  shutdown(): Promise<void>;
}

export function otlpBatcher<T>(options: OtlpBatcherOptions<T>): OtlpBatcher<T> {
  const { maxBatchSize, maxQueueSize, flushIntervalMs, post } = options;
  const queue: T[] = [];
  /** The ONE batch in flight, or `undefined`. Never a chain: see `pump`. */
  let sending: Promise<void> | undefined;

  /**
   * At most ONE batch in flight, and at most `maxBatchSize` items in it. Items WAIT IN the queue
   * while a POST is unsettled, where drop-oldest applies, so what is held is `maxQueueSize` plus
   * one batch — a stalled collector cannot grow memory. One at a time also keeps batches in
   * order, so a parent span never arrives after its child.
   */
  const pump = (): Promise<void> => {
    if (sending !== undefined) return sending;
    const batch = queue.splice(0, maxBatchSize);
    if (batch.length === 0) return Promise.resolve();
    const current = post(batch).then(
      () => undefined,
      () => undefined,
    );
    sending = current.then(() => {
      sending = undefined;
      // A full batch waiting behind a slow POST goes next without waiting for the timer.
      if (queue.length >= maxBatchSize) void pump();
    });
    return sending;
  };

  /** Everything queued NOW, batch by batch. Bounded, so a busy exporter cannot keep it looping. */
  const drainQueue = async (): Promise<void> => {
    let rounds = Math.ceil(queue.length / maxBatchSize) + 1;
    while (rounds > 0) {
      rounds -= 1;
      await pump();
      if (queue.length === 0 && sending === undefined) return;
    }
  };

  // Unref'd, so a pending flush never holds a draining process open — `shutdown()` decides the
  // last batch leaves. `pump`, never `drainQueue`: while a POST is stalled `pump` answers the send
  // already in flight and allocates nothing.
  const timer = setInterval(() => void pump(), flushIntervalMs);
  timer.unref();

  return {
    push(item: T): void {
      // Drop the OLDEST: the items an operator wants during an incident are the ones happening now.
      if (queue.length >= maxQueueSize) queue.shift();
      queue.push(item);
      if (queue.length >= maxBatchSize) void pump();
    },
    flush: drainQueue,
    async shutdown(): Promise<void> {
      clearInterval(timer);
      await drainQueue();
    },
  };
}
