// N concurrent misses on one key are ONE origin load. The mechanism is `@ultimat3/core`'s — this
// file's shape verbatim, one tier down, plus identity-checked eviction and an optional injected
// deadline — because four packages each grew their own deduper and only copies can drift. This
// file stays as the door `@ultimat3/cache` has always published it through, so no caller moves.
// `@ultimat3/realtime`'s `entry.reading` is the same shape one tier UP, adopting the same door.

export type { FlightJoin, SingleFlight } from '@ultimat3/core';
export { createSingleFlight } from '@ultimat3/core';
