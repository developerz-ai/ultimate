/**
 * An init script that makes the socket's echo of a like WIN the race against its HTTP answer, every
 * time: the like's response is held in the page until the page store's SYNCED row for that post has
 * moved — truth that, with the answer held, only a socket frame can have brought. Left to chance
 * the answer usually lands first and settles the overlay itself, so "no truth plus overlay" would
 * pass whether or not the frame named its write (#507). It observes and delays; it rewrites nothing.
 */

/** Where the script keeps what it held: one entry per like it intercepted, as JSON-safe values. */
export const ECHO_HOLDS = 'e2eEchoHolds';

/** Longest the answer is held. Past it the hold lets go and records `echoed: false` — a verdict. */
const HOLD_CAP_MS = 10_000;

/** What one held like recorded. `echoed` false: the frame never came, so the run proved nothing. */
export interface EchoHold {
  readonly postId: string;
  readonly before: number | null;
  readonly after: number | null;
  readonly echoed: boolean;
  /** The answer has been handed back to the page: the overlay's own settle may run from here. */
  readonly done: boolean;
}

export const ECHO_HOLD_SCRIPT = `(() => {
  const realFetch = globalThis.fetch;
  if (typeof realFetch !== 'function') return;
  const holds = (globalThis[${JSON.stringify(ECHO_HOLDS)}] = []);
  const synced = (postId) => {
    const row = globalThis[Symbol.for('ultimate.realtime')]?.store?.synced('posts', postId);
    return typeof row?.likeCount === 'number' ? row.likeCount : null;
  };
  const isLike = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = String(init?.method ?? (input instanceof Request ? input.method : 'GET'));
    return method.toUpperCase() === 'POST' && new URL(url, location.href).pathname === '/api/posts/like';
  };
  globalThis.fetch = async function (input, init) {
    if (!isLike(input, init)) return realFetch.call(this, input, init);
    let postId = '';
    try { postId = String(JSON.parse(String(init?.body)).postId ?? ''); } catch {}
    const entry = { postId, before: synced(postId), after: null, echoed: false, done: false };
    holds.push(entry);
    // The server has committed once it answers: the replication slot has the change, and the
    // frame naming it is on its way. Only its delivery is waited for — the body stays unread.
    const response = await realFetch.call(this, input, init);
    const cap = performance.now() + ${String(HOLD_CAP_MS)};
    while (performance.now() < cap) {
      const now = synced(postId);
      if (now !== null && now !== entry.before) {
        entry.after = now;
        entry.echoed = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    entry.done = true;
    return response;
  };
})();`;

/** The holds the page recorded, parsed rather than cast: the port answers `unknown`. */
export function echoHolds(value: unknown): readonly EchoHold[] {
  if (!Array.isArray(value)) return [];
  return value.map((one: unknown) => {
    const field = (key: string): unknown =>
      typeof one === 'object' && one !== null ? Reflect.get(one, key) : undefined;
    const count = (key: string): number | null => {
      const n = field(key);
      return typeof n === 'number' ? n : null;
    };
    return {
      postId: String(field('postId') ?? ''),
      before: count('before'),
      after: count('after'),
      echoed: field('echoed') === true,
      done: field('done') === true,
    };
  });
}
