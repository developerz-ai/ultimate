// When a shot may be TAKEN: the two rules that decide whether the page has finished hydrating,
// separated from both the command that drives a browser and the verdict that judges what came
// back. Plain values and an injected sleep, so the whole loop is proved with neither.

import type { IslandCount } from './shot-verdict';

/**
 * When there is nothing left to wait for. `booted` counts the islands whose chunk the runtime
 * ASKED for; `mounted` and `failed` are the two ways that request can end — so the outcome of
 * every boot exists exactly when they add up to it. An island that never booted is not something
 * to wait for (`visible` with nothing scrolled to it, `never` by declaration), and `null` is "the
 * page answered no probe", which no amount of waiting turns into an answer.
 */
export const islandsSettled = (islands: IslandCount | null): boolean =>
  islands === null || islands.mounted + islands.failed >= islands.booted;

/**
 * How often the island probe is re-read while the page settles. Short enough that a page whose
 * mounts have already resolved pays one extra read and nothing else.
 */
export const SETTLE_POLL_MS = 100;

export interface SettleOptions {
  /** The extra budget a mount gets AFTER the boot deadline. Bounded: a picture is still owed. */
  readonly windowMs: number;
  readonly pollMs: number;
  /** Injected by the test, so the poll is proved without spending its own window in real time. */
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
}

/**
 * Read the probe until every booted island has settled, or the window runs out.
 *
 * `DEFAULT_SETTLE_MS` is the deadline at which the hydration runtime CALLS `import()` — `mounted`
 * and `failed` land after it — so a single read at that instant reports `mounted: 0` for a page
 * that hydrates perfectly and the verdict was taken one tick before the outcome existed. Polling
 * is the only shape that ends EARLY on a fast page and still bounds a slow one.
 *
 * A `null` answer never overwrites a real count: `null` means "not counted", and a probe that
 * fails once would otherwise turn a page with islands into a page reported to have none.
 */
export async function settleIslands(
  probe: () => Promise<IslandCount | null>,
  options: SettleOptions,
): Promise<IslandCount | null> {
  const sleep = options.sleep ?? ((ms: number): Promise<void> => Bun.sleep(ms));
  let answer = await probe();
  let waited = 0;
  while (!islandsSettled(answer) && waited < options.windowMs) {
    // At least 1ms, or a `pollMs` of zero is a loop with no exit while the window stands.
    const step = Math.max(1, Math.min(options.pollMs, options.windowMs - waited));
    await sleep(step);
    waited += step;
    answer = (await probe()) ?? answer;
  }
  return answer;
}
